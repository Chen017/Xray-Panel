export type EditorState = {
  settings: any;
  xhttp: string;
  raw: string;
  rules: any[];
  relay: any;
  firewall: string;
};
export type EditorBaseline = EditorState & { nodeId: string; revision: number; hasSettings: boolean };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function formChanged(current: EditorState, baseline: EditorState) {
  return !same(current.settings, baseline.settings) || current.xhttp !== baseline.xhttp ||
    !same(current.rules, baseline.rules) || !same(current.relay, baseline.relay) || current.firewall !== baseline.firewall;
}
export function editorChanged(current: EditorState, baseline: EditorState) {
  return current.raw !== baseline.raw || formChanged(current, baseline);
}
export function draftPatch(current: EditorState, baseline: EditorBaseline): Record<string, any> | null {
  if (!editorChanged(current, baseline)) return null;
  const patch: Record<string, any> = { revision: baseline.revision };
  if (current.raw !== baseline.raw) {
    if (formChanged(current, baseline)) throw Error('完整配置与表单都有未保存修改，请选择保留其中一种编辑方式后再保存。');
    patch.bundle = JSON.parse(current.raw);
    return patch;
  }
  if (!same(current.settings, baseline.settings) || current.xhttp !== baseline.xhttp) {
    patch.settings = { ...current.settings, xhttp: JSON.parse(current.xhttp) };
    patch.initialize = !baseline.hasSettings;
  }
  if (!same(current.rules, baseline.rules)) patch.customRules = current.rules;
  if (!same(current.relay, baseline.relay)) patch.relay = current.relay;
  if (current.firewall !== baseline.firewall) patch.firewall = JSON.parse(current.firewall);
  return patch;
}
