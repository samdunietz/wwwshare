// Empties the R2 bucket between tests. Paginated so a single huge run
// doesn't leak state into the next file.
export async function clearBucket(env) {
  let cursor;
  do {
    const list = await env.WWWSHARE_BUCKET.list({ cursor });
    for (const obj of list.objects) {
      await env.WWWSHARE_BUCKET.delete(obj.key);
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}
