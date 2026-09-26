// Package updater is a minimal port of Electrobun's Bun Updater for the Go main
// process. It downloads the full bundle (no delta patches) and hands it to
// Electrobun's native update helper, which swaps the .app and relaunches it.
package updater

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// LocalInfo is the app's Resources/version.json, written by the build.
type LocalInfo struct {
	Version     string `json:"version"`
	Hash        string `json:"hash"`
	Channel     string `json:"channel"`
	BaseURL     string `json:"baseUrl"`
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Identifier  string `json:"identifier"`
}

// Manifest is <channel>-<os>-<arch>-update.json next to each release's artifacts.
type Manifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	Identifier    string `json:"identifier"`
	Channel       string `json:"channel"`
	Version       string `json:"version"`
	Hash          string `json:"hash"`
	Platform      string `json:"platform"`
	Arch          string `json:"arch"`
	Artifact      struct {
		File string `json:"file"`
	} `json:"artifact"`
}

type preparedUpdate struct {
	SchemaVersion   int    `json:"schema_version"`
	Identifier      string `json:"identifier"`
	Channel         string `json:"channel"`
	Version         string `json:"version"`
	Hash            string `json:"hash"`
	Platform        string `json:"platform"`
	Arch            string `json:"arch"`
	RetainedTarPath string `json:"retained_tar_path"`
	ArtifactFile    string `json:"artifact_file"`
}

type nativePlan struct {
	SchemaVersion   int    `json:"schema_version"`
	TransactionID   string `json:"transaction_id"`
	Identifier      string `json:"identifier"`
	Channel         string `json:"channel"`
	Platform        string `json:"platform"`
	Arch            string `json:"arch"`
	Version         string `json:"version"`
	Hash            string `json:"hash"`
	ChannelRoot     string `json:"channel_root"`
	AppBundlePath   string `json:"app_bundle_path"`
	RetainedTarPath string `json:"retained_tar_path"`
	ParentPID       int    `json:"parent_pid"`
	ResultPath      string `json:"result_path"`
}

const (
	maxManifestBytes = 1 << 20
	preparedFile     = ".electrobun-prepared-update.json"
)

var (
	safeHash   = regexp.MustCompile(`^[a-z0-9]{1,13}$`)
	unsafeName = regexp.MustCompile(`[\x00-\x1f\x7f/\\]`)
	unsafeFile = regexp.MustCompile(`[\x00-\x1f\x7f/\\:]`)
	ctrlChars  = regexp.MustCompile(`[\x00-\x1f\x7f]`)
)

type Updater struct {
	Info   LocalInfo
	exeDir string

	manifest *Manifest
}

// New reads version.json from the app bundle's Resources folder.
func New(exeDir, resourcesDir string) (*Updater, error) {
	data, err := os.ReadFile(filepath.Join(resourcesDir, "version.json"))
	if err != nil {
		return nil, err
	}
	u := &Updater{exeDir: exeDir}
	if err := json.Unmarshal(data, &u.Info); err != nil {
		return nil, fmt.Errorf("version.json: %w", err)
	}
	return u, nil
}

func goOS() string {
	if runtime.GOOS == "darwin" {
		return "macos"
	}
	if runtime.GOOS == "windows" {
		return "win"
	}
	return runtime.GOOS
}

func goArch() string {
	if runtime.GOARCH == "amd64" {
		return "x64"
	}
	return runtime.GOARCH
}

func (u *Updater) platformPrefix() string {
	return fmt.Sprintf("%s-%s-%s", u.Info.Channel, goOS(), goArch())
}

func safeIdentity(v string) bool {
	return v != "" && len(v) <= 256 && v != "." && v != ".." && !unsafeName.MatchString(v)
}

func randomID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (u *Updater) validate(m *Manifest) error {
	switch {
	case m.SchemaVersion != 1:
		return errors.New("invalid update manifest: unsupported schemaVersion")
	case m.Identifier != u.Info.Identifier || m.Channel != u.Info.Channel || m.Platform != goOS() || m.Arch != goArch():
		return errors.New("invalid update manifest: release identity does not match this app")
	case !safeIdentity(m.Identifier) || !safeIdentity(m.Channel) || m.Version == "" || len(m.Version) > 256 ||
		ctrlChars.MatchString(m.Version) || !safeHash.MatchString(m.Hash):
		return errors.New("invalid update manifest: unsafe release metadata")
	}
	f := m.Artifact.File
	if len(f) <= len(".tar.zst") || len(f) > 1024 || !strings.HasSuffix(f, ".tar.zst") ||
		unsafeFile.MatchString(f) || !strings.HasPrefix(f, u.platformPrefix()+"-") {
		return errors.New("invalid update manifest: unsafe artifact filename")
	}
	return nil
}

// Result of a check.
type Result struct {
	Available bool
	Ready     bool
	Version   string
}

// Check fetches the release manifest. Dev builds never update.
func (u *Updater) Check(ctx context.Context) (Result, error) {
	if u.Info.Channel == "dev" {
		return Result{}, nil
	}
	if u.Info.Channel != "stable" && u.Info.Channel != "canary" {
		return Result{}, fmt.Errorf("unsupported update channel: %s", u.Info.Channel)
	}
	if u.Info.BaseURL == "" {
		return Result{}, errors.New("no release.baseUrl in this build")
	}
	manifestURL := fmt.Sprintf("%s/%s-update.json?%s", strings.TrimRight(u.Info.BaseURL, "/"), u.platformPrefix(), randomID()[:16])
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	body, err := get(ctx, manifestURL)
	if err != nil {
		return Result{}, err
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, maxManifestBytes+1))
	if err != nil {
		return Result{}, err
	}
	if len(data) > maxManifestBytes {
		return Result{}, errors.New("update.json is too large")
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return Result{}, errors.New("update.json is not valid JSON")
	}
	if err := u.validate(&m); err != nil {
		return Result{}, err
	}
	u.manifest = &m
	if m.Hash == u.Info.Hash {
		return Result{Version: m.Version}, nil
	}
	return Result{Available: true, Ready: u.preparedMatches(&m), Version: m.Version}, nil
}

func get(ctx context.Context, rawURL string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return res.Body, nil
}

func appDataDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Application Support")
}

func exists(path string) bool {
	st, err := os.Lstat(path)
	return err == nil && st.Mode().IsRegular()
}

// channelRoot resolves the installed channel root the same way Electrobun does,
// preferring the root that already holds this build's state.
func (u *Updater) channelRoot() (string, error) {
	if !safeIdentity(u.Info.Identifier) || !safeIdentity(u.Info.Channel) {
		return "", errors.New("the installed update identity is unsafe")
	}
	idRoot := filepath.Join(appDataDir(), u.Info.Identifier)
	modern := filepath.Join(idRoot, u.Info.Channel)
	candidates := []string{modern}
	if safeIdentity(u.Info.Name) {
		candidates = append(candidates, filepath.Join(idRoot, u.Info.Name))
	}
	if u.Info.DisplayName != "" {
		legacy := u.Info.DisplayName
		if u.Info.Channel != "stable" {
			legacy += "-" + u.Info.Channel
		}
		if safeIdentity(legacy) {
			candidates = append(candidates, filepath.Join(idRoot, legacy))
		}
	}
	for _, c := range candidates {
		if exists(filepath.Join(c, "self-extraction", u.Info.Hash+".tar")) {
			return c, nil
		}
	}
	for _, c := range candidates {
		if exists(filepath.Join(c, ".electrobun-uninstall.json")) {
			return c, nil
		}
	}
	return modern, nil
}

func (u *Updater) preparedMatches(m *Manifest) bool {
	root, err := u.channelRoot()
	if err != nil {
		return false
	}
	data, err := os.ReadFile(filepath.Join(root, "self-extraction", preparedFile))
	if err != nil {
		return false
	}
	var p preparedUpdate
	if json.Unmarshal(data, &p) != nil {
		return false
	}
	return p.Hash == m.Hash && p.Version == m.Version && p.ArtifactFile == m.Artifact.File && exists(p.RetainedTarPath)
}

func writeJSONAtomic(path string, v any, mode os.FileMode) error {
	data, _ := json.Marshal(v)
	tmp := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	if err := os.WriteFile(tmp, append(data, '\n'), mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Download fetches and decompresses the full bundle for the manifest from the last
// Check, then records it as prepared.
func (u *Updater) Download(ctx context.Context) error {
	m := u.manifest
	if m == nil || m.Hash == u.Info.Hash {
		return errors.New("no update to download")
	}
	if u.preparedMatches(m) {
		return nil
	}
	root, err := u.channelRoot()
	if err != nil {
		return err
	}
	folder := filepath.Join(root, "self-extraction")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return err
	}
	tx := randomID()
	compressed := filepath.Join(folder, fmt.Sprintf(".%s.%s.tar.zst", m.Hash, tx))
	tarPartial := filepath.Join(folder, fmt.Sprintf("%s.tar.%s.partial", m.Hash, tx))
	retained := filepath.Join(folder, m.Hash+".tar")
	defer os.Remove(compressed)
	defer os.Remove(tarPartial)

	artifactURL := fmt.Sprintf("%s/%s?cache=%s", strings.TrimRight(u.Info.BaseURL, "/"), url.PathEscape(m.Artifact.File), tx)
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	body, err := get(ctx, artifactURL)
	if err != nil {
		return fmt.Errorf("update artifact request failed: %w", err)
	}
	f, err := os.OpenFile(compressed, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		body.Close()
		return err
	}
	_, err = io.Copy(f, body)
	body.Close()
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("downloading update: %w", err)
	}

	zstd := filepath.Join(u.exeDir, "zig-zstd")
	if !exists(zstd) {
		return errors.New("zig-zstd executable is missing from the app bundle")
	}
	if out, err := exec.Command(zstd, "decompress", "-i", compressed, "-o", tarPartial, "--no-timing").CombinedOutput(); err != nil {
		return fmt.Errorf("decompressing update: %v %s", err, strings.TrimSpace(string(out)))
	}
	if st, err := os.Stat(tarPartial); err != nil || st.Size() == 0 {
		return errors.New("decompressed update archive is empty")
	}
	if err := os.Rename(tarPartial, retained); err != nil {
		return err
	}
	return writeJSONAtomic(filepath.Join(folder, preparedFile), preparedUpdate{
		SchemaVersion: 1, Identifier: m.Identifier, Channel: m.Channel, Version: m.Version, Hash: m.Hash,
		Platform: m.Platform, Arch: m.Arch, RetainedTarPath: retained, ArtifactFile: m.Artifact.File,
	}, 0o644)
}

func parentPID() int {
	// Prefer the outer launcher PID so the helper waits for the whole process tree.
	if v := os.Getenv("ELECTROBUN_LAUNCHER_PID"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return os.Getpid()
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	return out.Close()
}

// Apply hands the prepared update to Electrobun's native helper, which waits for
// this app to exit, swaps the bundle and relaunches it. The caller must quit right
// after a nil return.
func (u *Updater) Apply() error {
	root, err := u.channelRoot()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(root, "self-extraction", preparedFile))
	if err != nil {
		return fmt.Errorf("no prepared update: %w", err)
	}
	var p preparedUpdate
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	if p.Hash == u.Info.Hash {
		return errors.New("already on the latest version")
	}
	if p.Identifier != u.Info.Identifier || p.Channel != u.Info.Channel || !safeHash.MatchString(p.Hash) ||
		p.RetainedTarPath != filepath.Join(root, "self-extraction", p.Hash+".tar") || !exists(p.RetainedTarPath) {
		return errors.New("prepared update doesn't match this app")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	bundle, err := filepath.Abs(filepath.Join(filepath.Dir(exe), "..", ".."))
	if err != nil {
		return err
	}

	helperSrc := filepath.Join(root, "uninstall")
	if !exists(helperSrc) {
		helperSrc = filepath.Join(bundle, "Contents", "Resources", "uninstall")
	}
	if !exists(helperSrc) {
		return errors.New("no installed or bundled native update manager is available")
	}
	tmp, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		return err
	}
	tx := randomID()
	helper := filepath.Join(tmp, "electrobun-update-"+tx)
	if err := copyFile(helperSrc, helper, 0o700); err != nil {
		return err
	}

	planPath := filepath.Join(root, fmt.Sprintf(".electrobun-update-%s.json", tx))
	plan := nativePlan{
		SchemaVersion: 1, TransactionID: tx, Identifier: u.Info.Identifier, Channel: u.Info.Channel,
		Platform: goOS(), Arch: goArch(), Version: p.Version, Hash: p.Hash,
		ChannelRoot: root, AppBundlePath: bundle, RetainedTarPath: p.RetainedTarPath, ParentPID: parentPID(),
		ResultPath: filepath.Join(root, fmt.Sprintf(".electrobun-update-%s.result.json", tx)),
	}
	if err := writeJSONAtomic(planPath, plan, 0o400); err != nil {
		os.Remove(helper)
		return err
	}
	cmd := exec.Command(helper, "--apply-update", planPath, "--quiet")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		os.Remove(planPath)
		os.Remove(helper)
		return fmt.Errorf("failed to start update helper: %w", err)
	}
	return cmd.Process.Release()
}

// NativeResult is what Electrobun's update helper writes after an install attempt.
type NativeResult struct {
	SchemaVersion int    `json:"schema_version"`
	TransactionID string `json:"transaction_id"`
	Success       bool   `json:"success"`
	Phase         string `json:"phase"`
	Message       string `json:"message"`
	Identifier    string `json:"identifier"`
	Channel       string `json:"channel"`
	Version       string `json:"version"`
	Hash          string `json:"hash"`
}

const observedResultFile = ".electrobun-observed-update-result.json"

var (
	resultFileName = regexp.MustCompile(`^\.electrobun-update-([a-f0-9]{32})\.result\.json$`)
	transactionID  = regexp.MustCompile(`^[a-f0-9]{32}$`)
	resultPhases   = map[string]bool{"validating": true, "waiting_for_parent": true, "extracting": true,
		"validating_payload": true, "swapping": true, "integrating": true, "launching": true, "complete": true}
)

// validResult checks a result file the way Electrobun does, without trusting its name.
func (u *Updater) validResult(data []byte, tx string) (*NativeResult, bool) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || len(fields) != 9 {
		return nil, false
	}
	var r NativeResult
	if json.Unmarshal(data, &r) != nil {
		return nil, false
	}
	ok := r.SchemaVersion == 1 && r.TransactionID == tx && transactionID.MatchString(tx) &&
		resultPhases[r.Phase] && r.Success == (r.Phase == "complete") &&
		r.Message != "" && len(r.Message) <= 4096 && !ctrlChars.MatchString(r.Message) &&
		r.Identifier == u.Info.Identifier && r.Channel == u.Info.Channel &&
		r.Version != "" && len(r.Version) <= 256 && !ctrlChars.MatchString(r.Version) && safeHash.MatchString(r.Hash)
	return &r, ok
}

// NewResult returns the outcome of the last install attempt if it hasn't been
// reported yet, and marks it reported. A success must match the running build; a
// failure is for a build other than the running one.
func (u *Updater) NewResult() (*NativeResult, error) {
	if u.Info.Channel == "dev" {
		return nil, nil
	}
	root, err := u.channelRoot()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil || len(entries) > 1024 {
		return nil, err
	}
	var best *NativeResult
	var bestTime time.Time
	for _, e := range entries {
		m := resultFileName.FindStringSubmatch(e.Name())
		if m == nil || !e.Type().IsRegular() {
			continue
		}
		info, err := e.Info()
		if err != nil || info.Size() <= 0 || info.Size() > 64*1024 {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, e.Name()))
		if err != nil {
			continue
		}
		r, ok := u.validResult(data, m[1])
		if !ok {
			continue
		}
		matches := (r.Success && r.Version == u.Info.Version && r.Hash == u.Info.Hash) || (!r.Success && r.Hash != u.Info.Hash)
		if matches && (best == nil || info.ModTime().After(bestTime)) {
			best, bestTime = r, info.ModTime()
		}
	}
	if best == nil {
		return nil, nil
	}
	observedPath := filepath.Join(root, observedResultFile)
	var observed struct {
		SchemaVersion int    `json:"schema_version"`
		TransactionID string `json:"transaction_id"`
	}
	if data, err := os.ReadFile(observedPath); err == nil && json.Unmarshal(data, &observed) == nil &&
		observed.TransactionID == best.TransactionID {
		return nil, nil
	}
	observed.SchemaVersion, observed.TransactionID = 1, best.TransactionID
	if err := writeJSONAtomic(observedPath, observed, 0o644); err != nil {
		return nil, err
	}
	return best, nil
}
