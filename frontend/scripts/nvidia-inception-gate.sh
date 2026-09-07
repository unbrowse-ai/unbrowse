#!/usr/bin/env bash
# NVIDIA Inception branding-compliance gate (jesus-ralph witness).
# Exits 0 EXACTLY when the site uses the NVIDIA Inception program badge per the
# official brand guidelines:
#   1. Official badge asset present + UNMODIFIED (size matches official for-screen RGB svg)
#   2. Badge actually displayed on a webpage (referenced by a component)
#   3. Required legal attribution line present, VERBATIM, trademarks alphabetical
#   4. No forbidden program-name forms (abbreviation / reorder / miscapitalisation)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0

LEGAL='© 2025 NVIDIA, the NVIDIA logo, and NVIDIA Inception are trademarks and/or registered trademarks of NVIDIA Corporation in the U.S. and other countries.'

# 1. Official badge asset, unmodified (official RGB for-screen svg = 13114 bytes)
if [ -f public/nvidia-inception.svg ]; then
  sz=$(wc -c < public/nvidia-inception.svg | tr -d ' ')
  if [ "$sz" = "13114" ]; then echo "ok   gate1: official badge svg present, unmodified ($sz bytes)";
  else echo "FAIL gate1: nvidia-inception.svg is $sz bytes, not the official 13114 (colors/art must not be altered)"; fail=1; fi
else echo "FAIL gate1: public/nvidia-inception.svg missing"; fail=1; fi

# 2. Badge displayed on a webpage
n=$(grep -rl "nvidia-inception.svg\|nvidia-inception.png" src --include="*.tsx" 2>/dev/null | wc -l | tr -d ' ')
if [ "$n" -ge 1 ]; then echo "ok   gate2: badge displayed in $n component(s)"; else echo "FAIL gate2: badge not referenced by any component"; fail=1; fi

# 3. Required legal attribution line, verbatim
if grep -rqF "$LEGAL" src 2>/dev/null; then echo "ok   gate3: legal attribution line present (verbatim)"; else echo "FAIL gate3: required NVIDIA legal attribution line missing"; fail=1; fi

# 4. No forbidden name forms (guideline 'Do Nots'). Filenames use lowercase 'nvidia-' and are exempt.
bad=0
for pat in "NV Inception" "Inception Program by NVIDIA" "NVIDIA INCEPTION" "Nvidia Inception"; do
  hits=$(grep -rF "$pat" src --include="*.tsx" 2>/dev/null | grep -vF "nvidia-inception." | wc -l | tr -d ' ')
  if [ "$hits" != "0" ]; then echo "FAIL gate4: forbidden form '$pat' in $hits place(s)"; bad=1; fi
done
[ "$bad" = "0" ] && echo "ok   gate4: no forbidden program-name forms" || fail=1

[ "$fail" = "0" ] && echo "GATE GREEN" || echo "GATE RED"
exit $fail
