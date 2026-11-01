#!/bin/bash
# Visual marker for end of Claude's turn - draws attention to any questions

# ANSI color codes
BOLD='\033[1m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
RESET='\033[0m'

# Output a visual marker that questions may be above
echo ""
printf "${BOLD}${CYAN}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${RESET}\n"
printf "${BOLD}${MAGENTA}┃  👆 Check above for questions or clarifications  ┃${RESET}\n"
printf "${BOLD}${CYAN}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${RESET}\n"
echo ""
