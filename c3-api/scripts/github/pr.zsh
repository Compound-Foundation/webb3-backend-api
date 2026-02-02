#!/usr/bin/env -S zsh -euo pipefail

typeset -A bindings=(
  [sha]=GITHUB_SHA
  [repo]=GITHUB_REPOSITORY
  [token]=GITHUB_TOKEN
  [action]=GITHUB_ACTION
  [github_api_base]=GITHUB_API_URL
)

local ok
for k v in ${(kv)bindings}; do
  if [[ -z ${(P)v} ]]; then
    >&2 print -Pf '─ ERROR: Missing environment variable %s.\n' ${v}
    ok=no
    continue
  fi
  typeset ${k}=${(P)v}
done

print ok=${ok}
if [[ -n ${ok} ]]; then return 1; fi

github_api="${github_api_base}/repos/${repo}"
response=$(                                  \
  curl                                       \
    -H 'Accept: application/vnd.github+json' \
    -H "Authorization: token ${token}"       \
    "${github_api}/commits/${sha}/pulls"     \
)

json=$(jq --compact-output '.[0] | { number, link: ._links.html.href }' <<< ${response})

if [[ ${json} =~ '\{"number":([[:digit:]]+),"link":"(.+)"\}' ]]; then
  print -f '%s\n'                          \
    GITHUB_PULL_REQUEST_NUMBER=${match[1]} \
    GITHUB_PULL_REQUEST_LINK=${match[2]}   \
  >> ${GITHUB_ENV}
else
  >&2 print -Pf '─ json did not match expected format. Got: ''%s''' ${json}
fi
