# Native nftables INPUT-chain inventory, including jumps, inline sets and named port sets.
.nftables as $items |
[$items[] | .chain? // empty | select(.hook == "input")] as $inputs |
[$items[] | .rule? // empty] as $rules |
def identity($object; $chain): [$object.family, $object.table, $chain] | join("/");
def reachable($seen):
    ([$rules[] | . as $rule | select($seen | index(identity($rule; $rule.chain))) |
        .expr[]? | (.jump.target? // .goto.target? // empty) | identity($rule; .)] + $seen | unique) as $next |
    if $next == ($seen | unique) then $next else reachable($next) end;
def ports:
    if type == "number" then "PORT " + tostring
    elif type == "array" then .[] | ports
    elif type == "object" and has("set") then .set | ports
    elif type == "object" and has("range") then "PORT " + (.range | map(tostring) | join("-"))
    else "COMPLEX" end;
reachable([$inputs[] | identity(.; .name)] | unique) as $reachable |
(if $inputs | length == 0 then empty else "CHECKED" end),
($inputs[] | if .policy == "accept" then "POLICY " + .family + " ACCEPT" else empty end),
($rules[] | . as $rule | select($reachable | index(identity($rule; $rule.chain))) |
    select(any(.expr[]?; has("accept"))) |
    .expr[]? | .match? // empty | select(.op == "==" or .op == "in") |
    select(.left.payload.field? == "dport" and (.left.payload.protocol == "tcp" or .left.payload.protocol == "udp" or .left.payload.protocol == "th")) |
    .right |
    if type == "string" and startswith("@") then
        .[1:] as $name |
        [$items[] | .set? // empty | select(.family == $rule.family and .table == $rule.table and .name == $name)] as $sets |
        if $sets | length == 0 then "COMPLEX" else $sets[].elem[]? | ports end
    else ports end)
