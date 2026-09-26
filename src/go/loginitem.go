package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Foundation -framework ServiceManagement
#import <ServiceManagement/ServiceManagement.h>
#include <stdlib.h>
#include <string.h>

static int uws_login_item_status(void) {
	return (int)[SMAppService mainAppService].status;
}

// Returns NULL on success, or an error message the caller frees.
static char *uws_login_item_set(int enable) {
	NSError *err = nil;
	SMAppService *app = [SMAppService mainAppService];
	BOOL ok = enable ? [app registerAndReturnError:&err] : [app unregisterAndReturnError:&err];
	if (ok) return NULL;
	const char *msg = err.localizedDescription.UTF8String;
	return strdup(msg ? msg : "unknown error");
}
*/
import "C"

import (
	"errors"
	"unsafe"

	"usagewindowstarter/src/go/core"
)

// The app registers itself as an "Open at Login" item with SMAppService, so
// macOS shows it with its own name and icon. A LaunchAgent is named after the
// program it runs ("open", then "launcher"), because the app has no Developer ID.

// SMAppService.Status values.
const (
	loginItemNotRegistered    = 0
	loginItemEnabled          = 1
	loginItemRequiresApproval = 2
	loginItemNotFound         = 3
)

func loginItemStatus() int { return int(C.uws_login_item_status()) }

// isLaunchAtLogin counts an item waiting for approval in System Settings as on.
func isLaunchAtLogin() bool {
	s := loginItemStatus()
	return s == loginItemEnabled || s == loginItemRequiresApproval
}

func setLaunchAtLogin(enabled bool) error {
	flag := C.int(0)
	if enabled {
		flag = 1
	}
	if msg := C.uws_login_item_set(flag); msg != nil {
		defer C.free(unsafe.Pointer(msg))
		return errors.New(C.GoString(msg))
	}
	return nil
}

// migrateLoginItem replaces a LaunchAgent login item from earlier versions.
func migrateLoginItem() {
	if core.RemoveLoginAgents() {
		if err := setLaunchAtLogin(true); err != nil {
			core.Log("event", "login-item-error", "error", err.Error())
		}
	}
}
