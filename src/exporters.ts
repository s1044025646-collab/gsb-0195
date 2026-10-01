import { CurveResult } from './types.js';

/** 导出曲线点为 CSV（含表头，单位写在列名中）。失败点字段留空。 */
export function curveToCsv(curve: CurveResult): string {
  const header = [
    'index',
    'voltage_V',
    'current_A',
    'power_W',
    'residual_A',
    'iterations',
    'status',
  ];
  const lines = [header.join(',')];
  for (const pt of curve.points) {
    lines.push(
      [
        pt.index,
        fmt(pt.v),
        pt.i === null ? '' : fmt(pt.i),
        pt.p === null ? '' : fmt(pt.p),
        pt.residual === null ? '' : fmt(pt.residual),
        pt.iterations,
        pt.status,
      ].join(',')
    );
  }
  return lines.join('\n') + '\n';
}

function fmt(x: number): string {
  // 使用足够精度，避免科学计数法之外的信息丢失。
  return Number.isFinite(x) ? String(x) : '';
}

export function comparisonToCsv(rows: Array<Record<string, number | string>>): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => String(row[h] ?? '')).join(','));
  }
  return lines.join('\n') + '\n';
}
