export const H2_WINDOW_MAX = 2147483647;
export const MIB = 1024 * 1024;

export const formatH2Window = bytes => `${(bytes / MIB).toFixed(20).replace(/0+$/, '').replace(/\.$/, '')}M`;

// The UI calls the binary unit M; Mihomo expects an integer byte count.
export function parseH2Window(value) {
  const text = String(value).trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)\s*M?$/i.test(text)) throw Error('窗口请输入 M 数值，例如 1M、10M 或 1.5M');
  const bytes = Math.round(Number(text.replace(/\s*M$/i, '')) * MIB);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > H2_WINDOW_MAX) throw Error('窗口必须大于 0 且不超过 2047.999999M（2147483647 字节）');
  return bytes;
}
