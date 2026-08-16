# Terminal Setup

Volt uses the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) for reliable modifier key detection. Most modern terminals support this protocol, but some require configuration.

## Kitty

Works out of the box.

## iTerm2

### Regular TUI mode

Works out of the box with terminal-owned native scrollback and inline images.

### Fullscreen TUI mode

Volt owns the viewport, so iTerm2 sends mouse-wheel reports instead of scrolling native scrollback. With iTerm2's default fast-trackpad behavior, those reports can lose most of an accelerated wheel delta, making fullscreen scrolling much slower than regular scrolling.

If fast mouse-wheel gestures move only about one line at a time:

1. Open **iTerm2 → Settings → Advanced**.
2. Search for **Trackpad scrolls fast?** and set it to **No**.

This is an iTerm2-wide workaround and may also change native trackpad scrolling. The underlying behavior is tracked in [iTerm2 issue 9619](https://gitlab.com/gnachman/iterm2/-/work_items/9619).

Fullscreen images render as text placeholders in iTerm2. Its inline-image protocol cannot delete or crop placements safely during application-owned scrolling. Regular mode continues to render iTerm2 inline images.

## Apple Terminal

Volt enables enhanced key reporting when available. If Terminal.app still sends plain Return for `Shift+Enter`, volt uses a local macOS modifier fallback to treat that Return as `Shift+Enter`.

This fallback only works when volt runs on the same Mac as Terminal.app. It cannot detect the local keyboard over remote SSH.

## Ghostty

Add to your Ghostty config (`~/Library/Application Support/com.mitchellh.ghostty/config` on macOS, `~/.config/ghostty/config` on Linux):

```
keybind = alt+backspace=text:\x1b\x7f
```

Older Claude Code versions may have added this Ghostty mapping:

```
keybind = shift+enter=text:\n
```

That mapping sends a raw linefeed byte. Inside Volt, that is indistinguishable from `Ctrl+J`, so tmux and Volt no longer see a real `shift+enter` key event.

If Claude Code 2.x or newer is the only reason you added that mapping, you can remove it, unless you want to use Claude Code in tmux, where it still requires that Ghostty mapping.

Volt binds `Ctrl+J` as a default newline alias, so `Shift+Enter` keeps working in tmux via that remap without extra Volt configuration.

### Fullscreen TUI mode

OSC 8 links remain clickable through Volt, but Ghostty does not show its hover underline or lower-left URL preview while Volt captures mouse input. Hold `Shift+Command` on macOS or `Shift+Ctrl` on Linux to use Ghostty's native link handling instead. Plain URLs that are not emitted as OSC 8 links still depend on the terminal's native link handling.

## WezTerm

WezTerm usually works out of the box for `Shift+Enter` via xterm modifyOtherKeys. To use the Kitty keyboard protocol explicitly, create `~/.wezterm.lua`:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

On macOS, WezTerm binds `Option+Enter` to fullscreen by default. To use `Option+Enter` for volt follow-up queueing, add this key override:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.keys = {
  {
    key = 'Enter',
    mods = 'ALT',
    action = wezterm.action.SendString('\x1b[13;3u'),
  },
}
return config
```

If you already have a `config.keys` table, add the entry to it.

On WSL, WezTerm may require a visible hardware cursor for IME candidate window positioning. If CJK IME candidates do not follow the text cursor, set `VOLT_HARDWARE_CURSOR=1` before running volt or set `showHardwareCursor` to `true` in settings.

## Alacritty

Alacritty usually works out of the box for `Shift+Enter`. On macOS, `Option+Enter` may arrive as plain `Enter`. To use `Option+Enter` for volt follow-up queueing, add to `~/.config/alacritty/alacritty.toml`:

```toml
[[keyboard.bindings]]
key = "Enter"
mods = "Alt"
chars = "\u001b[13;3u"
```

Restart Alacritty after changing the config.

## VS Code (Integrated Terminal)

VS Code 1.109.5 and newer enable Kitty keyboard protocol in the integrated terminal by default, so `Shift+Enter` should work out of the box.

VS Code versions older than 1.109.5 need an explicit terminal keybinding for `Shift+Enter`.

`keybindings.json` locations:
- macOS: `~/Library/Application Support/Code/User/keybindings.json`
- Linux: `~/.config/Code/User/keybindings.json`
- Windows: `%APPDATA%\\Code\\User\\keybindings.json`

Add to `keybindings.json`:

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

## tmux, GNU screen, and Zellij

Fullscreen mode captures mouse input for scrolling, links, selection, and scrollbar dragging. Under tmux, GNU screen, and Zellij, Volt deliberately requests button-motion tracking instead of all-motion tracking to avoid forwarding every passive pointer movement through the multiplexer. Clicks, wheel events, drag selection, and scrollbar dragging still work; passive hover feedback may not update until the next tracked event.

See [tmux setup](tmux.md) for modified-key forwarding. Fullscreen scrolling is application-owned and does not add rows to tmux or screen's native scrollback.

## Windows Terminal

Add to `settings.json` (Ctrl+Shift+, or Settings → Open JSON file) to forward the modified Enter keys volt uses:

```json
{
  "actions": [
    {
      "command": { "action": "sendInput", "input": "\u001b[13;2u" },
      "keys": "shift+enter"
    },
    {
      "command": { "action": "sendInput", "input": "\u001b[13;3u" },
      "keys": "alt+enter"
    }
  ]
}
```

- `Shift+Enter` inserts a new line.
- Windows Terminal binds `Alt+Enter` to fullscreen by default. That prevents volt from receiving `Alt+Enter` for follow-up queueing.
- Remapping `Alt+Enter` to `sendInput` forwards the real key chord to volt instead.

If you already have an `actions` array, add the objects to it. If the old fullscreen behavior persists, fully close and reopen Windows Terminal.

In fullscreen mode on native Windows, a right-click reads plaintext from the system clipboard and sends it as bracketed paste to the currently focused input. This avoids relying on terminal-owned paste handling while Volt captures mouse input. Image paste continues to use the configured `app.clipboard.pasteImage` binding.

## xfce4-terminal, terminator

These terminals have limited escape sequence support. Modified Enter keys like `Ctrl+Enter` and `Shift+Enter` cannot be distinguished from plain `Enter`, preventing custom keybindings such as `submit: ["ctrl+enter"]` from working.

For the best experience, use a terminal that supports the Kitty keyboard protocol:
- [Kitty](https://sw.kovidgoyal.net/kitty/)
- [Ghostty](https://ghostty.org/)
- [WezTerm](https://wezfurlong.org/wezterm/)
- [iTerm2](https://iterm2.com/)
- [Alacritty](https://github.com/alacritty/alacritty) (requires compilation with Kitty protocol support)

## Escape latency over SSH

Volt waits briefly after a lone Escape byte so it can distinguish the Escape key from a fragmented terminal sequence. The default is 10 ms locally and 100 ms when SSH environment variables are present. Set `VOLT_TUI_ESC_TIMEOUT` to a positive number of milliseconds if a high-latency connection needs a different lone-Escape window. Fragmented CSI and mouse sequences use separate input buffering and are not controlled by this setting.

## IntelliJ IDEA (Integrated Terminal)

The built-in terminal has limited escape sequence support. Shift+Enter cannot be distinguished from Enter in IntelliJ's terminal.

If you want the hardware cursor visible, set `VOLT_HARDWARE_CURSOR=1` before running volt (disabled by default for compatibility).

Consider using a dedicated terminal emulator for the best experience.
