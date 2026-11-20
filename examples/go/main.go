// Invisible Hands in Go: a destination with one control and one output.
//
//	go mod init demo && go get github.com/coder/websocket && go run . <room> [relay]
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type Msg struct {
	T    string       `json:"t"`
	To   string       `json:"to,omitempty"`
	From string       `json:"from,omitempty"`
	ID   string       `json:"id,omitempty"`
	P    string       `json:"p,omitempty"`
	V    *float64     `json:"v,omitempty"`
	Pts  [][2]float64 `json:"pts,omitempty"`
	Peer *struct {
		ID string `json:"id"`
	} `json:"peer,omitempty"`
	Params []map[string]any `json:"params,omitempty"`
	Outs   any              `json:"outs,omitempty"`
}

func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

func main() {
	room, relay := "test-room", "wss://invisible-hands.samuelling.workers.dev"
	if len(os.Args) > 1 {
		room = os.Args[1]
	}
	if len(os.Args) > 2 {
		relay = os.Args[2]
	}
	ctx := context.Background()
	c, _, err := websocket.Dial(ctx, relay+"/room/"+room+"?app=go-demo&name="+url.QueryEscape("Go demo"), nil)
	if err != nil {
		fmt.Println("cannot reach the relay:", err)
		os.Exit(1)
	}
	defer c.CloseNow()

	var mu sync.Mutex
	level, base, haveBase := 0.5, 0.0, false
	send := func(m any) {
		b, _ := json.Marshal(m)
		mu.Lock()
		defer mu.Unlock()
		c.Write(ctx, websocket.MessageText, b)
	}
	describe := func(to string) {
		send(map[string]any{"t": "describe", "to": to,
			"params": []map[string]any{{"id": "level", "label": "Level", "kind": "cont", "value": level}},
			"outs":   []map[string]any{{"id": "beat", "label": "Beat"}}})
	}

	go func() { // publish the output 15 times a second
		for range time.Tick(66 * time.Millisecond) {
			beat := 0.5 + 0.5*math.Sin(float64(time.Now().UnixMilli())/400)
			send(map[string]any{"t": "state", "outs": map[string]float64{"beat": math.Round(beat*1000) / 1000}})
		}
	}()

	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			fmt.Println("closed:", err)
			return
		}
		var m Msg
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch {
		case m.T == "welcome":
			fmt.Println("linked as", m.ID)
			describe("")
		case m.T == "join" && m.Peer != nil:
			describe(m.Peer.ID)
		case m.T == "set" && m.P == "level" && m.V != nil:
			level = clamp(*m.V, 0, 1)
			base, haveBase = level, true
		case m.T == "mod" && m.P == "level" && m.V != nil:
			if !haveBase {
				base, haveBase = level, true
			}
			level = clamp(base+clamp(*m.V, -1, 1), 0, 1)
		case m.T == "ramp" && m.P == "level" && len(m.Pts) > 0:
			level = clamp(m.Pts[len(m.Pts)-1][1], 0, 1) // jump to the end; GUIDE.md shows how to play it
		default:
			continue
		}
		fmt.Printf("%s level=%.3f\n", m.T, level)
	}
}
