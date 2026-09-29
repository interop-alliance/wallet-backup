/**
 * Empty stand-in for a Node built-in that a dependency reads at load time but
 * degrades without in the browser. The dev server aliases `fs` here, which is
 * what `tar-stream`'s own `browser` field (`"fs": false`) asks for.
 */
export {}
