/** A deliberately narrow text rule; a negative result never establishes site safety. */
export function detectEmergency(text: string): boolean {
  const danger =
    /燃气(?:泄漏|味)|煤气(?:泄漏|味)|漏气|着火|火灾|明火|火苗|浓烟|冒烟|触电|电火花|有人受伤|有人被困/g;
  for (const clause of text.split(/[，,。；;！？!?\n]/u)) {
    for (const match of clause.matchAll(danger)) {
      const before = clause.slice(0, match.index).replace(/\s+/gu, "");
      const negated =
        /(?:没有|并无|不存在|未|没|无|不是)(?:闻到|发现|看到|见到|见|发生|出现|任何|明显|的迹象)*$/u.test(
          before,
        );
      const doubleNegative = /(?:不是|并非|不能说)(?:没有|无|未见)$/u.test(
        before,
      );
      if (!negated || doubleNegative) return true;
    }
  }
  return false;
}
