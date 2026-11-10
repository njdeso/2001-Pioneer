// Module hooks: map firebase-admin/app and firebase-admin/firestore to the read-only test stubs.
export async function resolve(spec, ctx, next) {
  if (spec === 'firebase-admin/app') return { url: new URL('./app.mjs', import.meta.url).href, shortCircuit: true };
  if (spec === 'firebase-admin/firestore') return { url: new URL('./firestore.mjs', import.meta.url).href, shortCircuit: true };
  return next(spec, ctx);
}
