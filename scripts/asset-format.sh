#!/usr/bin/env bash
# asset_format_ok FILE — true when FILE is a native executable (ELF, Mach-O,
# PE) or a gzip archive (nanoclaw's runtime tree). Release steps refuse
# anything else: a failed hermes build once published upstream's 273-byte
# launcher script as the Windows binary, and the rolling release carried it
# forward from the per-SHA tag.
asset_format_ok() {
  local magic
  magic="$(head -c 4 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
  case "$magic" in
    7f454c46|cffaedfe|cefaedfe|feedfacf|feedface|cafebabe) return 0 ;;
  esac
  [[ "${magic:0:4}" == "4d5a" || "${magic:0:4}" == "1f8b" ]]
}
