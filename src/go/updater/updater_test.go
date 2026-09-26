package updater

import (
	"os"
	"path/filepath"
	"testing"
)

func testUpdater() *Updater {
	return &Updater{Info: LocalInfo{Identifier: "dev.foksa.usage-window-starter", Channel: "stable", Hash: "aaaa"}}
}

func goodManifest() Manifest {
	m := Manifest{SchemaVersion: 1, Identifier: "dev.foksa.usage-window-starter", Channel: "stable", Version: "0.3.0",
		Hash: "bbbb", Platform: goOS(), Arch: goArch()}
	m.Artifact.File = "stable-" + goOS() + "-" + goArch() + "-UsageWindowStarter.app.tar.zst"
	return m
}

func TestValidateAcceptsMatchingRelease(t *testing.T) {
	m := goodManifest()
	if err := testUpdater().validate(&m); err != nil {
		t.Fatal(err)
	}
}

func TestValidateRejectsUnsafeOrForeignReleases(t *testing.T) {
	cases := map[string]func(*Manifest){
		"other app":         func(m *Manifest) { m.Identifier = "com.example.other" },
		"other channel":     func(m *Manifest) { m.Channel = "canary" },
		"bad hash":          func(m *Manifest) { m.Hash = "../../x" },
		"path in artifact":  func(m *Manifest) { m.Artifact.File = "stable-macos-arm64-../evil.tar.zst" },
		"wrong prefix":      func(m *Manifest) { m.Artifact.File = "canary-macos-arm64-App.app.tar.zst" },
		"not a tar.zst":     func(m *Manifest) { m.Artifact.File = "stable-macos-arm64-App.zip" },
		"unknown schema":    func(m *Manifest) { m.SchemaVersion = 2 },
		"control character": func(m *Manifest) { m.Version = "1.0\n" },
	}
	for name, mutate := range cases {
		m := goodManifest()
		mutate(&m)
		if err := testUpdater().validate(&m); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestChannelRootPrefersRootWithCurrentBuild(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	u := testUpdater()
	u.Info.Name = "UsageWindowStarter"
	idRoot := filepath.Join(home, "Library", "Application Support", u.Info.Identifier)
	legacy := filepath.Join(idRoot, u.Info.Name, "self-extraction")
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, u.Info.Hash+".tar"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	root, err := u.channelRoot()
	if err != nil || root != filepath.Join(idRoot, u.Info.Name) {
		t.Fatal(root, err)
	}
	if err := os.RemoveAll(filepath.Join(idRoot, u.Info.Name)); err != nil {
		t.Fatal(err)
	}
	if root, _ := u.channelRoot(); root != filepath.Join(idRoot, "stable") {
		t.Fatal("fallback root", root)
	}
}

func TestDevBuildsNeverUpdate(t *testing.T) {
	u := testUpdater()
	u.Info.Channel = "dev"
	if res, err := u.Check(t.Context()); err != nil || res.Available {
		t.Fatal(res, err)
	}
}

func TestNewResultReportsEachInstallOnce(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	u := testUpdater()
	u.Info.Version = "0.2.0"
	root := filepath.Join(home, "Library", "Application Support", u.Info.Identifier, "stable")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(tx string, r NativeResult) {
		r.SchemaVersion, r.TransactionID, r.Identifier, r.Channel = 1, tx, u.Info.Identifier, u.Info.Channel
		if err := writeJSONAtomic(filepath.Join(root, ".electrobun-update-"+tx+".result.json"), r, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	tx := "0123456789abcdef0123456789abcdef"
	write(tx, NativeResult{Success: false, Phase: "swapping", Message: "disk full", Version: "0.3.0", Hash: "bbbb"})

	r, err := u.NewResult()
	if err != nil || r == nil || r.Success || r.Phase != "swapping" || r.Version != "0.3.0" {
		t.Fatalf("%+v %v", r, err)
	}
	if r, _ := u.NewResult(); r != nil {
		t.Fatal("reported twice")
	}

	// A success must describe the running build.
	tx2 := "fedcba9876543210fedcba9876543210"
	write(tx2, NativeResult{Success: true, Phase: "complete", Message: "done", Version: "0.2.0", Hash: "aaaa"})
	if r, _ := u.NewResult(); r == nil || !r.Success || r.TransactionID != tx2 {
		t.Fatalf("%+v", r)
	}
}

func TestNewResultIgnoresMalformedFiles(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	u := testUpdater()
	root := filepath.Join(home, "Library", "Application Support", u.Info.Identifier, "stable")
	_ = os.MkdirAll(root, 0o755)
	name := filepath.Join(root, ".electrobun-update-0123456789abcdef0123456789abcdef.result.json")
	// success doesn't match phase, and an extra field
	_ = os.WriteFile(name, []byte(`{"schema_version":1,"transaction_id":"0123456789abcdef0123456789abcdef","success":true,"phase":"swapping","message":"x","identifier":"dev.foksa.usage-window-starter","channel":"stable","version":"0.3.0","hash":"bbbb","extra":1}`), 0o644)
	if r, err := u.NewResult(); r != nil || err != nil {
		t.Fatalf("%+v %v", r, err)
	}
}
