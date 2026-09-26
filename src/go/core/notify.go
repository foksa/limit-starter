package core

import (
	"fmt"
	"os/exec"
	"strings"
)

// Notifier shows a notification. The menu bar app swaps in its native notifications
// so they show under the app's name.
var Notifier = func(title, message string) {
	esc := strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	_ = exec.Command("osascript", "-e",
		fmt.Sprintf(`display notification "%s" with title "%s"`, esc.Replace(message), esc.Replace(title))).Run()
}

// Notify is best-effort.
func Notify(title, message string) {
	defer func() { _ = recover() }()
	Notifier(title, message)
}
