import {
  Document,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  AlignmentType,
  WidthType,
  Packer,
  BorderStyle,
  ShadingType,
} from 'docx';

// ---------------------------------------------------------------------------
// Types (mirrors audit.service.ts)
// ---------------------------------------------------------------------------

interface AuditRecord {
  pk_project_audit: string;
  fk_audit_project: string;
  fk_audit_module?: string | null;
  audit_source: string;
  audit_source_url: string | null;
  audit_title?: string;
  audit_summary?: string;
  audit_data: Record<string, any>;
  audit_ai_analysis: Record<string, any> | null;
  audit_ai_provider: string | null;
  audit_ai_score?: number | null;
  created_at: string;
  created_by: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DARK_BLUE = '1e3a5f';
const SLATE = '334155';
const GREEN = '059669';
const AMBER = 'd97706';
const RED = 'dc2626';
const LIGHT_BG = 'f8fafc';
const WHITE = 'ffffff';
const BODY_COLOR = '333333';

// ---------------------------------------------------------------------------
// JSON Export
// ---------------------------------------------------------------------------

export function exportAsJson(audit: AuditRecord): string {
  return JSON.stringify(audit, null, 2);
}

// ---------------------------------------------------------------------------
// Markdown Export
// ---------------------------------------------------------------------------

export function exportAsMarkdown(audit: AuditRecord): string {
  const lines: string[] = [];
  const data = audit.audit_data;
  const ai = audit.audit_ai_analysis;
  const date = new Date(audit.created_at).toLocaleString();

  if (audit.audit_source === 'git') {
    const meta = data.meta as any;
    const health = data.projectHealth as any;
    const contributors = data.contributors as Record<string, any> | undefined;
    const owner = meta?.owner || '';
    const repo = meta?.repo || '';

    lines.push(`# Git Audit Report — ${owner}/${repo}`);
    lines.push(`Generated: ${date}`);
    lines.push('');

    // Summary
    const commitCount = meta?.totalCommitsProcessed || 0;
    const prCount = health?.totalPRs || 0;
    const mergedPRs = health?.totalMergedPRs || 0;
    const contribCount = contributors ? Object.keys(contributors).length : 0;
    const branchCount = health?.totalBranches || 0;
    const avgCycle = health?.avgCycleHours != null ? `${Number(health.avgCycleHours).toFixed(1)}h` : 'N/A';

    lines.push('## Summary');
    lines.push(`- Commits: ${commitCount}`);
    lines.push(`- Pull Requests: ${prCount} (${mergedPRs} merged)`);
    lines.push(`- Contributors: ${contribCount}`);
    lines.push(`- Branches: ${branchCount}`);
    lines.push(`- Avg PR Cycle Time: ${avgCycle}`);
    lines.push('');

    // PR Type Distribution
    const prTypeDist = health?.prTypeDist as Record<string, number> | undefined;
    if (prTypeDist && Object.keys(prTypeDist).length > 0) {
      lines.push('## PR Type Distribution');
      lines.push('| Type | Count |');
      lines.push('|------|-------|');
      for (const [type, count] of Object.entries(prTypeDist)) {
        lines.push(`| ${type} | ${count} |`);
      }
      lines.push('');
    }

    // Contributors table
    if (contributors && Object.keys(contributors).length > 0) {
      lines.push('## Contributors');
      lines.push('| Contributor | Score | Commits | +Lines | -Lines | PRs | Reviews | Msg Quality |');
      lines.push('|-------------|-------|---------|--------|--------|-----|---------|-------------|');
      const sorted = Object.entries(contributors).sort(
        ([, a]: [string, any], [, b]: [string, any]) => (b.compositeScore || 0) - (a.compositeScore || 0)
      );
      for (const [login, c] of sorted) {
        const score = c.compositeScore != null ? Number(c.compositeScore).toFixed(1) : '-';
        const commits = c.commits?.length || 0;
        const adds = c.totalAdditions || 0;
        const dels = c.totalDeletions || 0;
        const prs = c.totalPRsAuthored || 0;
        const reviews = c.totalPRsReviewed || 0;
        const msgQ = c.avgMsgQuality != null ? Number(c.avgMsgQuality).toFixed(1) : '-';
        lines.push(`| ${login} | ${score} | ${commits} | ${adds} | ${dels} | ${prs} | ${reviews} | ${msgQ} |`);
      }
      lines.push('');
    }

    // Commit Velocity by Month
    const velocity = health?.commitVelocity as Record<string, number> | undefined;
    if (velocity && Object.keys(velocity).length > 0) {
      lines.push('## Commit Velocity by Month');
      lines.push('| Month | Commits |');
      lines.push('|-------|---------|');
      for (const [month, count] of Object.entries(velocity)) {
        lines.push(`| ${month} | ${count} |`);
      }
      lines.push('');
    }

    // AI Analysis
    if (ai) {
      lines.push('## AI Analysis');
      if (ai.overallScore != null) lines.push(`**Overall Score:** ${ai.overallScore}/100`);
      if (ai.completionEstimate != null) lines.push(`**Completion Estimate:** ${ai.completionEstimate}%`);
      lines.push('');
      if (ai.summary) {
        lines.push('### Summary');
        lines.push(String(ai.summary));
        lines.push('');
      }
      if (ai.findings && Array.isArray(ai.findings) && ai.findings.length > 0) {
        lines.push('### Findings');
        for (const f of ai.findings) {
          const sev = (f.severity || 'INFO').toUpperCase();
          lines.push(`- [${sev}] ${f.description || f.title || ''} — ${f.evidence || ''}`);
        }
        lines.push('');
      }
      if (ai.recommendations && Array.isArray(ai.recommendations) && ai.recommendations.length > 0) {
        lines.push('### Recommendations');
        for (let i = 0; i < ai.recommendations.length; i++) {
          const rec = ai.recommendations[i];
          const text = typeof rec === 'string' ? rec : rec.text || rec.description || JSON.stringify(rec);
          lines.push(`${i + 1}. ${text}`);
        }
        lines.push('');
      }
    }
  } else if (audit.audit_source === 'deep-audit') {
    // Deep audit report
    lines.push(`# Deep Audit Report — ${audit.audit_title || 'Deep Audit'}`);
    lines.push(`Generated: ${date}`);
    lines.push('');

    if (data.phases) {
      const p = data.phases as any;
      lines.push('## Audit Pipeline');
      lines.push(`- Files scanned: ${p.discovery?.filteredFiles || '?'} (of ${p.discovery?.totalFiles || '?'} total)`);
      lines.push(`- AI selected: ${p.selection?.selectedFiles || '?'} files`);
      lines.push(`- Files loaded: ${p.loading?.loadedFiles || '?'} (${p.loading?.totalContentKB || '?'} KB)`);
      lines.push(`- LLM batches: ${p.analysis?.batchesProcessed || '?'}`);
      lines.push(`- Stub files: ${p.discovery?.stubCount || '?'}`);
      lines.push('');
    }

    if (data.scores) {
      lines.push('## Scores');
      lines.push('| Dimension | Score |');
      lines.push('|-----------|-------|');
      for (const [key, score] of Object.entries(data.scores as Record<string, number>)) {
        lines.push(`| ${key.replace(/([A-Z])/g, ' $1').trim()} | ${score}/100 |`);
      }
      lines.push('');
    }

    if (data.summary) { lines.push('## Executive Summary'); lines.push(String(data.summary)); lines.push(''); }
    if (data.completenessAssessment) { lines.push('## Completeness Assessment'); lines.push(String(data.completenessAssessment)); lines.push(''); }

    if (data.techStack) {
      const ts = data.techStack as any;
      lines.push('## Technology Stack');
      if (ts.languages) { lines.push('**Languages:** ' + Object.entries(ts.languages).map(([l, p]) => `${l} (${p}%)`).join(', ')); }
      if (ts.frameworks?.length) { lines.push('**Frameworks:** ' + ts.frameworks.join(', ')); }
      lines.push('');
    }

    if (data.findings && Array.isArray(data.findings) && data.findings.length > 0) {
      lines.push('## Findings');
      for (const f of data.findings as any[]) {
        const sev = (f.severity || 'INFO').toUpperCase();
        lines.push(`- [${sev}] **${f.title || ''}** — ${f.description || ''}`);
        if (f.evidence) lines.push(`  _Evidence: ${f.evidence}_`);
        if (f.files?.length) lines.push(`  Files: ${f.files.join(', ')}`);
      }
      lines.push('');
    }

    if (data.recommendations) {
      const rec = data.recommendations as any;
      lines.push('## Recommendations');
      if (rec.mustFix?.length) { lines.push('### Must Fix'); rec.mustFix.forEach((r: string) => lines.push(`- ${r}`)); lines.push(''); }
      if (rec.shouldFix?.length) { lines.push('### Should Fix'); rec.shouldFix.forEach((r: string) => lines.push(`- ${r}`)); lines.push(''); }
      if (rec.niceToHave?.length) { lines.push('### Nice to Have'); rec.niceToHave.forEach((r: string) => lines.push(`- ${r}`)); lines.push(''); }
    }

    if (data.stubFiles && Array.isArray(data.stubFiles) && data.stubFiles.length > 0) {
      lines.push('## Stub / Incomplete Files');
      for (const f of data.stubFiles as any[]) { lines.push(`- ${f.path} (${f.size}B)`); }
      lines.push('');
    }
  } else {
    // Manual / project audit
    lines.push(`# Audit Report — ${audit.audit_title || 'Project Audit'}`);
    lines.push(`Generated: ${date}`);
    lines.push('');

    if (ai) {
      lines.push('## AI Analysis');
      if (ai.overallScore != null) lines.push(`**Overall Score:** ${ai.overallScore}/100`);
      if (ai.completionEstimate != null) lines.push(`**Completion Estimate:** ${ai.completionEstimate}%`);
      lines.push('');
      if (ai.summary) {
        lines.push('### Summary');
        lines.push(String(ai.summary));
        lines.push('');
      }
      if (ai.findings && Array.isArray(ai.findings) && ai.findings.length > 0) {
        lines.push('### Findings');
        for (const f of ai.findings) {
          const sev = (f.severity || 'INFO').toUpperCase();
          lines.push(`- [${sev}] ${f.description || f.title || ''} — ${f.evidence || ''}`);
        }
        lines.push('');
      }
      if (ai.recommendations && Array.isArray(ai.recommendations) && ai.recommendations.length > 0) {
        lines.push('### Recommendations');
        for (let i = 0; i < ai.recommendations.length; i++) {
          const rec = ai.recommendations[i];
          const text = typeof rec === 'string' ? rec : rec.text || rec.description || JSON.stringify(rec);
          lines.push(`${i + 1}. ${text}`);
        }
        lines.push('');
      }
    }

    // Include raw audit data summary if no AI analysis
    if (!ai && audit.audit_summary) {
      lines.push('## Summary');
      lines.push(audit.audit_summary);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// DOCX helpers
// ---------------------------------------------------------------------------

function heading1(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 300, after: 150 },
    children: [new TextRun({ text, bold: true, font: 'Arial', size: 32, color: DARK_BLUE })],
  });
}

function heading2(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text, bold: true, font: 'Arial', size: 26, color: SLATE })],
  });
}

function bodyText(text: string, options?: { bold?: boolean; color?: string; italic?: boolean }): Paragraph {
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({
        text,
        font: 'Arial',
        size: 20,
        color: options?.color || BODY_COLOR,
        bold: options?.bold,
        italics: options?.italic,
      }),
    ],
  });
}

function bulletText(text: string, options?: { bold?: boolean; color?: string }): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 60 },
    children: [
      new TextRun({
        text,
        font: 'Arial',
        size: 20,
        color: options?.color || BODY_COLOR,
        bold: options?.bold,
      }),
    ],
  });
}

function headerCell(text: string, widthPct: number): TableCell {
  return new TableCell({
    shading: { type: ShadingType.SOLID, color: DARK_BLUE },
    width: { size: widthPct, type: WidthType.PERCENTAGE },
    children: [
      new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [new TextRun({ text, bold: true, font: 'Arial', size: 18, color: WHITE })],
      }),
    ],
  });
}

function dataCell(text: string, rowIndex: number, widthPct: number, options?: { bold?: boolean; color?: string }): TableCell {
  const isAlt = rowIndex % 2 === 0;
  return new TableCell({
    shading: isAlt ? { type: ShadingType.SOLID, color: LIGHT_BG } : undefined,
    width: { size: widthPct, type: WidthType.PERCENTAGE },
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text,
            font: 'Arial',
            size: 18,
            color: options?.color || BODY_COLOR,
            bold: options?.bold,
          }),
        ],
      }),
    ],
  });
}

function severityColor(severity: string): string {
  const s = (severity || '').toUpperCase();
  if (s === 'CRITICAL' || s === 'HIGH') return RED;
  if (s === 'WARNING' || s === 'MEDIUM') return AMBER;
  return GREEN;
}

function prTypeColor(type: string): string {
  const t = (type || '').toLowerCase();
  if (t === 'feature' || t === 'feat') return GREEN;
  if (t === 'bug' || t === 'bugfix' || t === 'fix') return RED;
  if (t === 'chore' || t === 'maintenance') return SLATE;
  return AMBER;
}

function emptyTable(): Paragraph {
  return bodyText('No data available.', { italic: true });
}

// ---------------------------------------------------------------------------
// DOCX Export
// ---------------------------------------------------------------------------

export async function exportAsDocx(audit: AuditRecord): Promise<Buffer> {
  const data = audit.audit_data;
  const ai = audit.audit_ai_analysis;
  const date = new Date(audit.created_at).toLocaleString();
  const sections: (Paragraph | Table)[] = [];

  if (audit.audit_source === 'git') {
    const meta = data.meta as any;
    const health = data.projectHealth as any;
    const contributors = data.contributors as Record<string, any> | undefined;
    const owner = meta?.owner || '';
    const repo = meta?.repo || '';

    // Title
    sections.push(
      new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { after: 100 },
        children: [
          new TextRun({ text: `Git Audit Report`, bold: true, font: 'Arial', size: 48, color: DARK_BLUE }),
        ],
      })
    );
    sections.push(
      new Paragraph({
        spacing: { after: 40 },
        children: [
          new TextRun({ text: `${owner}/${repo}`, font: 'Arial', size: 28, color: SLATE, bold: true }),
        ],
      })
    );
    sections.push(
      new Paragraph({
        spacing: { after: 20 },
        children: [
          new TextRun({ text: `Branch: ${meta?.branch || 'main'}`, font: 'Arial', size: 20, color: BODY_COLOR }),
        ],
      })
    );
    sections.push(
      new Paragraph({
        spacing: { after: 300 },
        children: [
          new TextRun({ text: `Generated: ${date}`, font: 'Arial', size: 20, color: BODY_COLOR }),
        ],
      })
    );

    // Executive Summary
    sections.push(heading1('Executive Summary'));

    const commitCount = meta?.totalCommitsProcessed || 0;
    const prCount = health?.totalPRs || 0;
    const mergedPRs = health?.totalMergedPRs || 0;
    const contribCount = contributors ? Object.keys(contributors).length : 0;
    const branchCount = health?.totalBranches || 0;
    const avgCycle = health?.avgCycleHours != null ? `${Number(health.avgCycleHours).toFixed(1)}h` : 'N/A';

    const summaryData = [
      ['Commits', String(commitCount)],
      ['Pull Requests', `${prCount} (${mergedPRs} merged)`],
      ['Contributors', String(contribCount)],
      ['Branches', String(branchCount)],
      ['Avg PR Cycle Time', avgCycle],
    ];

    const summaryWidths = [40, 60];
    sections.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
          bottom: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
          left: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
          right: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
          insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
        },
        rows: [
          new TableRow({
            children: [headerCell('Metric', summaryWidths[0]), headerCell('Value', summaryWidths[1])],
          }),
          ...summaryData.map(
            ([metric, value], i) =>
              new TableRow({
                children: [
                  dataCell(metric, i, summaryWidths[0], { bold: true }),
                  dataCell(value, i, summaryWidths[1]),
                ],
              })
          ),
        ],
      }) as unknown as Paragraph
    );

    // PR Type Distribution
    const prTypeDist = health?.prTypeDist as Record<string, number> | undefined;
    if (prTypeDist && Object.keys(prTypeDist).length > 0) {
      sections.push(heading1('PR Type Distribution'));
      const prTypeWidths = [50, 50];
      sections.push(
        new Table({
          width: { size: 60, type: WidthType.PERCENTAGE },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            left: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            right: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
          },
          rows: [
            new TableRow({
              children: [headerCell('Type', prTypeWidths[0]), headerCell('Count', prTypeWidths[1])],
            }),
            ...Object.entries(prTypeDist).map(
              ([type, count], i) =>
                new TableRow({
                  children: [
                    dataCell(type, i, prTypeWidths[0], { bold: true, color: prTypeColor(type) }),
                    dataCell(String(count), i, prTypeWidths[1]),
                  ],
                })
            ),
          ],
        }) as unknown as Paragraph
      );
    }

    // Contributors table
    if (contributors && Object.keys(contributors).length > 0) {
      sections.push(heading1('Contributors'));
      const cWidths = [16, 10, 10, 12, 12, 10, 10, 10];
      // If we have very wide content we just do percentage based
      const sorted = Object.entries(contributors).sort(
        ([, a]: [string, any], [, b]: [string, any]) => (b.compositeScore || 0) - (a.compositeScore || 0)
      );

      sections.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            left: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            right: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
          },
          rows: [
            new TableRow({
              children: [
                headerCell('Contributor', cWidths[0]),
                headerCell('Score', cWidths[1]),
                headerCell('Commits', cWidths[2]),
                headerCell('+Lines', cWidths[3]),
                headerCell('-Lines', cWidths[4]),
                headerCell('PRs', cWidths[5]),
                headerCell('Reviews', cWidths[6]),
                headerCell('Msg Qual', cWidths[7]),
              ],
            }),
            ...sorted.map(([login, c], i) => {
              const score = c.compositeScore != null ? Number(c.compositeScore).toFixed(1) : '-';
              const commits = String(c.commits?.length || 0);
              const adds = String(c.totalAdditions || 0);
              const dels = String(c.totalDeletions || 0);
              const prs = String(c.totalPRsAuthored || 0);
              const reviews = String(c.totalPRsReviewed || 0);
              const msgQ = c.avgMsgQuality != null ? Number(c.avgMsgQuality).toFixed(1) : '-';
              return new TableRow({
                children: [
                  dataCell(login, i, cWidths[0], { bold: true }),
                  dataCell(score, i, cWidths[1]),
                  dataCell(commits, i, cWidths[2]),
                  dataCell(adds, i, cWidths[3]),
                  dataCell(dels, i, cWidths[4]),
                  dataCell(prs, i, cWidths[5]),
                  dataCell(reviews, i, cWidths[6]),
                  dataCell(msgQ, i, cWidths[7]),
                ],
              });
            }),
          ],
        }) as unknown as Paragraph
      );
    }

    // Commit Velocity by Month
    const velocity = health?.commitVelocity as Record<string, number> | undefined;
    if (velocity && Object.keys(velocity).length > 0) {
      sections.push(heading1('Commit Velocity by Month'));
      const vWidths = [50, 50];
      sections.push(
        new Table({
          width: { size: 60, type: WidthType.PERCENTAGE },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            left: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            right: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
          },
          rows: [
            new TableRow({
              children: [headerCell('Month', vWidths[0]), headerCell('Commits', vWidths[1])],
            }),
            ...Object.entries(velocity).map(
              ([month, count], i) =>
                new TableRow({
                  children: [
                    dataCell(month, i, vWidths[0]),
                    dataCell(String(count), i, vWidths[1]),
                  ],
                })
            ),
          ],
        }) as unknown as Paragraph
      );
    }

    // AI Analysis
    if (ai) {
      sections.push(heading1('AI Analysis'));
      if (ai.overallScore != null) {
        sections.push(bodyText(`Overall Score: ${ai.overallScore}/100`, { bold: true }));
      }
      if (ai.completionEstimate != null) {
        sections.push(bodyText(`Completion Estimate: ${ai.completionEstimate}%`, { bold: true }));
      }
      if (ai.summary) {
        sections.push(heading2('Summary'));
        sections.push(bodyText(String(ai.summary)));
      }
      if (ai.findings && Array.isArray(ai.findings) && ai.findings.length > 0) {
        sections.push(heading2('Findings'));
        const fWidths = [15, 45, 40];
        sections.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
              bottom: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
              left: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
              right: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
              insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
              insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            },
            rows: [
              new TableRow({
                children: [
                  headerCell('Severity', fWidths[0]),
                  headerCell('Description', fWidths[1]),
                  headerCell('Evidence', fWidths[2]),
                ],
              }),
              ...ai.findings.map((f: any, i: number) => {
                const sev = (f.severity || 'INFO').toUpperCase();
                return new TableRow({
                  children: [
                    dataCell(sev, i, fWidths[0], { bold: true, color: severityColor(sev) }),
                    dataCell(f.description || f.title || '', i, fWidths[1]),
                    dataCell(f.evidence || '', i, fWidths[2]),
                  ],
                });
              }),
            ],
          }) as unknown as Paragraph
        );
      }
      if (ai.recommendations && Array.isArray(ai.recommendations) && ai.recommendations.length > 0) {
        sections.push(heading2('Recommendations'));
        for (let i = 0; i < ai.recommendations.length; i++) {
          const rec = ai.recommendations[i];
          const text = typeof rec === 'string' ? rec : rec.text || rec.description || JSON.stringify(rec);
          sections.push(bulletText(`${text}`));
        }
      }
    }
  } else if (audit.audit_source === 'deep-audit') {
    // Deep Audit DOCX
    sections.push(
      new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { after: 100 },
        children: [
          new TextRun({ text: audit.audit_title || 'Deep Audit Report', bold: true, font: 'Arial', size: 48, color: DARK_BLUE }),
        ],
      })
    );
    sections.push(bodyText(`Generated: ${date}`));
    sections.push(bodyText(''));

    // Pipeline summary
    if (data.phases) {
      const p = data.phases as any;
      sections.push(heading1('Audit Pipeline'));
      const pipelineRows = [
        ['Files Scanned', `${p.discovery?.filteredFiles || '?'} of ${p.discovery?.totalFiles || '?'} total`],
        ['AI Selected', `${p.selection?.selectedFiles || '?'} files`],
        ['Files Loaded', `${p.loading?.loadedFiles || '?'} (${p.loading?.totalContentKB || '?'} KB)`],
        ['LLM Batches', `${p.analysis?.batchesProcessed || '?'}`],
        ['Stub Files', `${p.discovery?.stubCount || '?'}`],
      ];
      sections.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: [headerCell('Metric', 50), headerCell('Value', 50)] }),
          ...pipelineRows.map((r, i) => new TableRow({ children: [dataCell(r[0], i, 50, { bold: true }), dataCell(r[1], i, 50)] })),
        ],
      }));
      sections.push(bodyText(''));
    }

    // Scores
    if (data.scores && typeof data.scores === 'object') {
      sections.push(heading1('Scores'));
      const scoreEntries = Object.entries(data.scores as Record<string, number>);
      sections.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: [headerCell('Dimension', 60), headerCell('Score', 40)] }),
          ...scoreEntries.map(([key, score], i) => new TableRow({
            children: [
              dataCell(key.replace(/([A-Z])/g, ' $1').trim(), i, 60),
              dataCell(`${score}/100`, i, 40, { bold: true, color: Number(score) >= 70 ? GREEN : Number(score) >= 40 ? AMBER : RED }),
            ],
          })),
        ],
      }));
      sections.push(bodyText(''));
    }

    // Summary
    if (data.summary) {
      sections.push(heading1('Executive Summary'));
      sections.push(bodyText(String(data.summary)));
      sections.push(bodyText(''));
    }

    // Completeness Assessment
    if (data.completenessAssessment) {
      sections.push(heading1('Completeness Assessment'));
      sections.push(bodyText(String(data.completenessAssessment)));
      sections.push(bodyText(''));
    }

    // Tech Stack
    if (data.techStack) {
      const ts = data.techStack as any;
      sections.push(heading1('Technology Stack'));
      if (ts.languages && typeof ts.languages === 'object') {
        sections.push(bodyText('Languages: ' + Object.entries(ts.languages).map(([l, p]) => `${l} (${p}%)`).join(', ')));
      }
      if (ts.frameworks?.length) {
        sections.push(bodyText('Frameworks: ' + ts.frameworks.join(', ')));
      }
      if (ts.testFrameworks?.length) {
        sections.push(bodyText('Test Frameworks: ' + ts.testFrameworks.join(', ')));
      }
      sections.push(bodyText(''));
    }

    // Findings
    if (data.findings && Array.isArray(data.findings) && data.findings.length > 0) {
      sections.push(heading1(`Findings (${data.findings.length})`));
      sections.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: [headerCell('Severity', 12), headerCell('Category', 15), headerCell('Title', 25), headerCell('Description', 33), headerCell('Files', 15)] }),
          ...(data.findings as any[]).map((f: any, i: number) => new TableRow({
            children: [
              dataCell((f.severity || 'info').toUpperCase(), i, 12, { bold: true, color: severityColor(f.severity) }),
              dataCell(f.category || '', i, 15),
              dataCell(f.title || '', i, 25, { bold: true }),
              dataCell(f.description || '', i, 33),
              dataCell((f.files || []).join(', '), i, 15),
            ],
          })),
        ],
      }));
      sections.push(bodyText(''));
    }

    // Recommendations
    if (data.recommendations) {
      const rec = data.recommendations as any;
      sections.push(heading1('Recommendations'));
      if (rec.mustFix?.length) {
        sections.push(heading2('Must Fix'));
        for (const r of rec.mustFix) sections.push(bulletText(typeof r === 'string' ? r : JSON.stringify(r)));
      }
      if (rec.shouldFix?.length) {
        sections.push(heading2('Should Fix'));
        for (const r of rec.shouldFix) sections.push(bulletText(typeof r === 'string' ? r : JSON.stringify(r)));
      }
      if (rec.niceToHave?.length) {
        sections.push(heading2('Nice to Have'));
        for (const r of rec.niceToHave) sections.push(bulletText(typeof r === 'string' ? r : JSON.stringify(r)));
      }
      sections.push(bodyText(''));
    }

    // Stub files
    if (data.stubFiles && Array.isArray(data.stubFiles) && data.stubFiles.length > 0) {
      sections.push(heading1(`Stub / Incomplete Files (${data.stubFiles.length})`));
      for (const f of (data.stubFiles as any[]).slice(0, 50)) {
        sections.push(bulletText(`${f.path} (${f.size}B)`));
      }
      if (data.stubFiles.length > 50) sections.push(bodyText(`... and ${data.stubFiles.length - 50} more`));
    }
  } else {
    // Project / manual audit
    sections.push(
      new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { after: 100 },
        children: [
          new TextRun({ text: audit.audit_title || 'Project Audit Report', bold: true, font: 'Arial', size: 48, color: DARK_BLUE }),
        ],
      })
    );
    sections.push(
      new Paragraph({
        spacing: { after: 300 },
        children: [
          new TextRun({ text: `Generated: ${date}`, font: 'Arial', size: 20, color: BODY_COLOR }),
        ],
      })
    );

    if (ai) {
      sections.push(heading1('AI Analysis'));
      if (ai.overallScore != null) {
        sections.push(bodyText(`Overall Score: ${ai.overallScore}/100`, { bold: true }));
      }
      if (ai.completionEstimate != null) {
        sections.push(bodyText(`Completion Estimate: ${ai.completionEstimate}%`, { bold: true }));
      }
      if (ai.summary) {
        sections.push(heading2('Summary'));
        sections.push(bodyText(String(ai.summary)));
      }
      if (ai.findings && Array.isArray(ai.findings) && ai.findings.length > 0) {
        sections.push(heading2('Findings'));
        const fWidths = [15, 45, 40];
        sections.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
              bottom: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
              left: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
              right: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
              insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
              insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'e2e8f0' },
            },
            rows: [
              new TableRow({
                children: [
                  headerCell('Severity', fWidths[0]),
                  headerCell('Description', fWidths[1]),
                  headerCell('Evidence', fWidths[2]),
                ],
              }),
              ...ai.findings.map((f: any, i: number) => {
                const sev = (f.severity || 'INFO').toUpperCase();
                return new TableRow({
                  children: [
                    dataCell(sev, i, fWidths[0], { bold: true, color: severityColor(sev) }),
                    dataCell(f.description || f.title || '', i, fWidths[1]),
                    dataCell(f.evidence || '', i, fWidths[2]),
                  ],
                });
              }),
            ],
          }) as unknown as Paragraph
        );
      }
      if (ai.recommendations && Array.isArray(ai.recommendations) && ai.recommendations.length > 0) {
        sections.push(heading2('Recommendations'));
        for (let i = 0; i < ai.recommendations.length; i++) {
          const rec = ai.recommendations[i];
          const text = typeof rec === 'string' ? rec : rec.text || rec.description || JSON.stringify(rec);
          sections.push(bulletText(`${text}`));
        }
      }
    }

    if (!ai && audit.audit_summary) {
      sections.push(heading1('Summary'));
      sections.push(bodyText(audit.audit_summary));
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Arial', size: 20, color: BODY_COLOR },
        },
      },
    },
    sections: [
      {
        children: sections,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  return buffer as Buffer;
}
