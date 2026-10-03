/** Zeichenkodierungen, die die Banken verwenden. */
export type TextEncoding = 'utf-8' | 'windows-1252' | 'iso-8859-1';

/**
 * Windows-1252 weicht nur in 0x80–0x9F von ISO-8859-1 ab (€, „“, –, …).
 * Eigene Tabelle statt TextDecoder: Node 22 dekodiert diesen Bereich als
 * Steuerzeichen (U+0080 statt €). Undefinierte Bytes bleiben U+0080+n.
 */
const CP1252_HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d,
  0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x009d, 0x017e, 0x0178,
];

function decodeWindows1252(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.subarray(i, i + 8192);
    text += String.fromCharCode(...Array.from(chunk, (b) => (b >= 0x80 && b <= 0x9f ? (CP1252_HIGH[b - 0x80] as number) : b)));
  }
  return text;
}

/**
 * Dekodiert Dateiinhalt mit fest vorgegebenem Encoding – nie geraten,
 * nie stillschweigend UTF-8. Ein BOM wird entfernt. Bei UTF-8 sind
 * ungültige Bytefolgen ein Fehler (deutet auf falschen Adapter hin).
 * „ISO-8859-1“ wird wie im Web-Standard (WHATWG) als Windows-1252
 * gelesen – Banken meinen damit praktisch immer diese Obermenge.
 */
export function decodeText(bytes: Uint8Array, encoding: TextEncoding): string {
  const text =
    encoding === 'utf-8' ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) : decodeWindows1252(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
