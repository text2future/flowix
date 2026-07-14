let renderCounter = 0;
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

const MERMAID_FONT_FAMILY = 'Nunito Sans, Inter, -apple-system, Segoe UI, sans-serif';
const FLOWCHART_PADDING = 6;
const FLOWCHART_NODE_SPACING = 28;
const FLOWCHART_RANK_SPACING = 36;

export class MermaidParseError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('Mermaid parse error');
    this.name = 'MermaidParseError';
    this.cause = cause;
  }
}

function createConfig() {
  return {
    startOnLoad: false,
    securityLevel: 'strict' as const,
    theme: 'default' as const,
    htmlLabels: true,
    fontFamily: MERMAID_FONT_FAMILY,
    flowchart: {
      padding: FLOWCHART_PADDING,
      nodeSpacing: FLOWCHART_NODE_SPACING,
      rankSpacing: FLOWCHART_RANK_SPACING,
    },
  };
}

async function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((module) => {
      const mermaid = module.default;
      mermaid.initialize(createConfig());
      return mermaid;
    });
  }

  return mermaidPromise;
}

export async function renderMermaidDiagram(source: string): Promise<string> {
  const mermaid = await getMermaid();
  mermaid.initialize(createConfig());

  try {
    await mermaid.parse(source);
  } catch (error) {
    throw new MermaidParseError(error);
  }

  const id = `flowix-mermaid-${Date.now()}-${renderCounter++}`;
  const result = await mermaid.render(id, source);
  return result.svg;
}
