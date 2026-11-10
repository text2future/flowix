/**
 * Note-document placeholder shown while a Markdown surface resolves its editor.
 * Markdown surfaces never use the common centered loader; they paint this
 * skeleton inside the surface until the document session is ready.
 *
 * The content column mirrors the real document exactly: the user-configured
 * --editor-document-width (set on :root by useApplyFontSettings, "none" for
 * full width) centered with margin auto, and the same 3rem/6rem inline
 * padding the editor switches on at 860px pane width. The outer node is an
 * inline-size container so the padding reacts to the surface pane width even
 * outside .markdown-editor (Suspense fallback paints before the editor mounts).
 */
export function NoteDocumentLoadingSkeleton({ className = '' }: { className?: string }) {
  // Weaker than generic skeletons: 36% opacity and a slow, gentle pulse so the
  // placeholder stays subtle until the editor paints over it.
  const title = 'animate-pulse rounded-lg bg-[var(--muted)] opacity-[0.36] [animation-duration:2.4s] motion-reduce:animate-none';
  const line = 'animate-pulse rounded bg-[var(--muted)] opacity-[0.36] [animation-duration:2.4s] motion-reduce:animate-none';
  return (
    <div
      className={`h-full w-full ${className}`}
      style={{ containerType: 'inline-size', containerName: 'note-skeleton' }}
    >
      <div
        aria-hidden="true"
        className="note-document-skeleton mx-auto w-full pt-[25px]"
        style={{ maxWidth: 'var(--editor-document-width, 680px)' }}
      >
        {/* 25px = .memo-date-line height: the skeleton title box starts where
         * the real title glyphs start (date line + optional icon row aside).
         * Title box height mirrors .memo-title-shell: font size x2.1, line
         * height 1.15, so it tracks the user's font-size setting. */}
        <span
          className={`block w-2/5 ${title}`}
          style={{ height: 'calc(var(--editor-font-size, 16px) * 2.1 * 1.15)' }}
        />
        <span className={`mt-7 block h-[21px] w-1/3 ${line}`} />
        <span className={`mt-3 block h-[21px] w-full ${line}`} />
      </div>
    </div>
  );
}
