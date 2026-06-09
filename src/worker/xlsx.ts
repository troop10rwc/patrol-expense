// Minimal, dependency-free .xlsx reader. A Google Sheet export?format=xlsx is a
// ZIP of XML parts; we read every worksheet so the importer can see all tabs
// (the CSV export only yields the first tab). Uses DecompressionStream
// ("deflate-raw"), available in both the Workers runtime and Node 18+.

interface ZipEntry { offset: number; method: number; size: number }

function readCentralDirectory(buf: ArrayBuffer): Map<string, ZipEntry> {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const dec = new TextDecoder();
  // Find the End Of Central Directory record (scan the tail for its signature).
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65536); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid .xlsx (no ZIP end-of-central-directory)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const map = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true); // compressed size
    const fnLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + fnLen));
    map.set(name, { offset: localOff, method, size });
    p += 46 + fnLen + extraLen + commentLen;
  }
  return map;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(buf: ArrayBuffer, entry: ZipEntry): Promise<string> {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  if (dv.getUint32(entry.offset, true) !== 0x04034b50) throw new Error("bad ZIP local header");
  const fnLen = dv.getUint16(entry.offset + 26, true);
  const extraLen = dv.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + fnLen + extraLen;
  const comp = u8.subarray(start, start + entry.size);
  const out = entry.method === 0 ? comp : await inflateRaw(comp);
  return new TextDecoder().decode(out);
}

function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    switch (e) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
    }
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si\s*\/>|<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[1] === undefined) { out.push(""); continue; }
    let s = "";
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(m[1]))) s += t[1];
    out.push(decodeXml(s));
  }
  return out;
}

function colIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)![1];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const cells: { row: number; col: number; val: string }[] = [];
  let maxRow = -1, maxCol = -1;
  // Scan opening <c …> tags; a trailing "/" means a self-closing (empty) cell,
  // otherwise read up to the matching </c>. (Handling self-closing cells
  // explicitly is essential — a paired-only regex would swallow them and grab a
  // later cell's <v>.)
  const cOpen = /<c\s+r="([A-Z]+)(\d+)"([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = cOpen.exec(xml))) {
    const col = colIndex(m[1]);
    const row = Number(m[2]) - 1;
    const attrs = m[3];
    if (m[4] === "/") continue; // self-closing, no value
    const end = xml.indexOf("</c>", cOpen.lastIndex);
    if (end < 0) break;
    const inner = xml.slice(cOpen.lastIndex, end);
    cOpen.lastIndex = end + 4;
    const ty = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? null;
    let val = "";
    if (ty === "inlineStr") {
      const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
      let t: RegExpExecArray | null;
      while ((t = tRe.exec(inner))) val += t[1];
      val = decodeXml(val);
    } else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      if (v) val = ty === "s" ? (shared[Number(v[1])] ?? "") : decodeXml(v[1]);
    }
    if (val === "") continue;
    cells.push({ row, col, val });
    if (row > maxRow) maxRow = row;
    if (col > maxCol) maxCol = col;
  }
  const rows: string[][] = Array.from({ length: maxRow + 1 }, () => Array<string>(maxCol + 1).fill(""));
  for (const c of cells) rows[c.row][c.col] = c.val;
  return rows;
}

/** Parse an .xlsx into its worksheets, in workbook order, each as a rows×cols grid. */
export async function parseXlsxTabs(buf: ArrayBuffer): Promise<{ name: string; rows: string[][] }[]> {
  const entries = readCentralDirectory(buf);
  const get = async (path: string): Promise<string | null> => {
    const e = entries.get(path);
    return e ? readEntry(buf, e) : null;
  };

  const sharedXml = await get("xl/sharedStrings.xml");
  const shared = sharedXml ? parseSharedStrings(sharedXml) : [];

  const workbookXml = await get("xl/workbook.xml");
  const relsXml = await get("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relsXml) throw new Error("missing workbook parts in .xlsx");

  const ridToTarget = new Map<string, string>();
  const relRe = /<Relationship\s+([^>]*?)\/>/g;
  let r: RegExpExecArray | null;
  while ((r = relRe.exec(relsXml))) {
    const id = /\bId="([^"]+)"/.exec(r[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(r[1])?.[1];
    if (id && target) ridToTarget.set(id, target);
  }

  const tabs: { name: string; rows: string[][] }[] = [];
  const sheetRe = /<sheet\s+([^>]*?)\/>/g;
  let s: RegExpExecArray | null;
  while ((s = sheetRe.exec(workbookXml))) {
    const name = decodeXml(/\bname="([^"]+)"/.exec(s[1])?.[1] ?? "");
    const rid = /\br:id="([^"]+)"/.exec(s[1])?.[1];
    const target = rid ? ridToTarget.get(rid) : undefined;
    if (!target) continue;
    const path = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    const xml = await get(path);
    tabs.push({ name, rows: xml ? parseSheet(xml, shared) : [] });
  }
  return tabs;
}
