# Midnight Commander TypeScript configuration

Midnight Commander is configured to recognize TypeScript source files and use
`nano` for editing plus `bat`/`less` for a syntax-highlighted viewer.

## Configuration file

`~/.config/mc/mc.ext.ini`

```ini
[Typescript]
Regex=\\.(ts|tsx)$
RegexIgnoreCase=true
Open=nano %f
View=bat --color=always --paging=always --pager='less -R' --style=plain --language=TypeScript %f
```

## Use

- `F3`: opens the selected `.ts` or `.tsx` file in `bat`, using `less` as the
  pager with ANSI colors preserved. Press `q` to return to Midnight Commander.
- `F4`: opens the file in `nano`.

## Requirements

- `bat` must be installed and available on `PATH`.
- `less` must support the `-R` option (standard GNU `less` does).

## Reloading changes

Restart Midnight Commander after editing `mc.ext.ini`. Alternatively, open
**F9 → Command → Edit extension file**, then exit the editor; MC reloads the
extension configuration at that point.

## Why an external viewer is used

MC's internal viewer can display plain text, but it does not reliably interpret
the ANSI color sequences emitted by `bat` (especially modern 24-bit colors).
Running `bat` externally and preserving its output through `less -R` provides
working syntax highlighting.
