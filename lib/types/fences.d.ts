/**
 * Fence-aware extraction of code from model answers.
 *
 * Born from a real bug: a live run asked for five files in five calls, and the
 * report glued the chunks together with plain-text separators. One answer had an
 * unterminated ``` fence, so the next separator landed *inside* the open block and
 * the assembled "content.js" failed to parse — the code was fine, the assembler was
 * not. Never trust a model to close its own fences.
 */
export interface CodeChunk {
    file: string;
    language: string;
    body: string;
    /** true when the answer never closed the fence this chunk came from */
    unterminated: boolean;
}
/** A directory tree or a prose paragraph is not a source file. */
export declare function looksLikeCode(body: string, language: string): boolean;
export declare function extractCodeChunks(answer: string): CodeChunk[];
/**
 * The last complete definition of a file wins, because a model that restates a file
 * is usually fixing it. A later *truncated* restatement must not throw away an earlier
 * complete version, so an unterminated chunk only wins when nothing complete follows.
 */
export declare function dedupeByName(chunks: CodeChunk[]): CodeChunk[];
export interface BundleReport {
    kept: CodeChunk[];
    rejected: {
        file: string;
        reason: string;
    }[];
}
export declare function classifyChunks(chunks: CodeChunk[]): BundleReport;
//# sourceMappingURL=fences.d.ts.map