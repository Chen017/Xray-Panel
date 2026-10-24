// One order for the node table and every device's exported subscription.
export function orderNodes(nodes, order=[]) {
  const ranks=new Map(order.map((id,index)=>[id,index]));
  return [...nodes].sort((a,b)=>(ranks.get(a.id)??Number.MAX_SAFE_INTEGER)-(ranks.get(b.id)??Number.MAX_SAFE_INTEGER)||(a.createdAt??'').localeCompare(b.createdAt??'')||a.id.localeCompare(b.id));
}
