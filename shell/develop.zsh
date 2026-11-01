# Use this checkout's minimal configuration when starting OpenCode.
export OPENCODE_CONFIG_DIR="${${(%):-%x}:A:h:h}/opencode"

# Pick an installed coding-agent CLI; extra arguments pass through.
develop() {
  local -a agents
  local name
  for name in claude cursor-agent codex opencode pi agy; do
    (( $+commands[$name] )) && agents+=$name
  done
  (( $#agents )) || { print -u2 "develop: no agent CLIs found on PATH"; return 1 }

  local selected=1 key i
  trap 'print -n "\e[?25h"' EXIT
  print -n '\e[?25l'
  print -P "%BSelect an agent%b %F{8}(↑/↓ Enter, q to quit)%f"
  while true; do
    for i in {1..$#agents}; do
      if (( i == selected )); then print -P "%F{cyan}❯ $agents[i]%f"; else print "  $agents[i]"; fi
    done
    read -rsk1 key
    case $key in
      $'\e')
        read -rsk2 key
        case $key in
          '[A') (( selected = selected > 1 ? selected - 1 : $#agents )) ;;
          '[B') (( selected = selected < $#agents ? selected + 1 : 1 )) ;;
        esac ;;
      k) (( selected = selected > 1 ? selected - 1 : $#agents )) ;;
      j) (( selected = selected < $#agents ? selected + 1 : 1 )) ;;
      $'\n'|$'\r') break ;;
      q) print -n "\e[$(( $#agents + 1 ))A\e[J"; return 130 ;;
    esac
    print -n "\e[${#agents}A"
  done
  print -n "\e[$(( $#agents + 1 ))A\e[J"
  print -P "%F{8}→ $agents[selected] $*%f"
  command $agents[selected] "$@"
}
