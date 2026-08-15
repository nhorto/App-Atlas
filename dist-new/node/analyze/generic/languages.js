import { goDialect } from './go/dialect.js';
import { detectGoBoundaries } from './go/boundaries.js';
import { csharpDialect } from './csharp/dialect.js';
import { detectCSharpBoundaries } from './csharp/boundaries.js';
import { rustDialect } from './rust/dialect.js';
import { detectRustBoundaries } from './rust/boundaries.js';
export const LANGUAGES = [
    { dialect: goDialect, boundaries: detectGoBoundaries },
    { dialect: csharpDialect, boundaries: detectCSharpBoundaries },
    { dialect: rustDialect, boundaries: detectRustBoundaries },
];
/** The language that claims a file, by extension, or null when none does. */
export function languageFor(relPath) {
    const dot = relPath.lastIndexOf('.');
    if (dot === -1)
        return null;
    const ext = relPath.slice(dot).toLowerCase();
    for (const language of LANGUAGES) {
        if (!language.dialect.extensions.includes(ext))
            continue;
        if (language.dialect.skip?.some((pattern) => pattern.test(relPath)))
            return null;
        return language;
    }
    return null;
}
//# sourceMappingURL=languages.js.map