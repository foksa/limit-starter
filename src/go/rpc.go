package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"
)

// A tiny host side of Electrobun's view RPC: requests get a response packet,
// messages are fire-and-forget. Packets arrive through the webview's host bridge.
type rpcPacket struct {
	Type    string          `json:"type"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	Payload json.RawMessage `json:"payload"`
}

type rpcHandlers struct {
	requests map[string]func(params json.RawMessage) (any, error)
	messages map[string]func(payload json.RawMessage)
}

var (
	viewsMu sync.RWMutex
	views   = map[uint32]*rpcHandlers{}
)

func registerView(webviewID uint32, h *rpcHandlers) {
	viewsMu.Lock()
	views[webviewID] = h
	viewsMu.Unlock()
}

func forgetView(webviewID uint32) {
	viewsMu.Lock()
	delete(views, webviewID)
	viewsMu.Unlock()
}

func hostBridge(webviewID uint32, message string) {
	var p rpcPacket
	if json.Unmarshal([]byte(message), &p) != nil {
		return
	}
	viewsMu.RLock()
	h := views[webviewID]
	viewsMu.RUnlock()
	if h == nil {
		return
	}
	// Handlers may run CLIs for minutes; never block the native thread.
	switch p.Type {
	case "request":
		fn := h.requests[p.Method]
		go func() {
			if fn == nil {
				sendResponse(webviewID, p.ID, nil, fmt.Errorf("unknown request %q", p.Method))
				return
			}
			result, err := fn(p.Params)
			sendResponse(webviewID, p.ID, result, err)
		}()
	case "message":
		var name string
		_ = json.Unmarshal(p.ID, &name)
		if fn := h.messages[name]; fn != nil {
			go fn(p.Payload)
		}
	}
}

// drainHostMessages delivers view packets that the core queued instead of passing
// to the bridge callback.
func drainHostMessages() {
	for {
		id, message, ok := app.core.PopNextQueuedHostMessageString()
		if !ok {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		hostBridge(id, message)
	}
}

func sendPacket(webviewID uint32, packet any) {
	data, err := json.Marshal(packet)
	if err != nil {
		return
	}
	if err := app.core.SendHostMessageToWebviewJSON(webviewID, string(data)); err != nil {
		fmt.Fprintln(os.Stderr, "[usage-window-starter] send to view:", err)
	}
}

func sendResponse(webviewID uint32, id json.RawMessage, result any, err error) {
	if err != nil {
		sendPacket(webviewID, map[string]any{"type": "response", "id": id, "success": false, "error": err.Error()})
		return
	}
	sendPacket(webviewID, map[string]any{"type": "response", "id": id, "success": true, "payload": result})
}

func sendMessage(webviewID uint32, name string, payload any) {
	sendPacket(webviewID, map[string]any{"type": "message", "id": name, "payload": payload})
}
