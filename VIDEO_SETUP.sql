-- =============================================================
-- cozmic video posting setup (Supabase SQL Editor)
-- Review your existing posts policies before applying in production.
-- This keeps existing posts and adds the video columns if missing.
-- =============================================================

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS media_type text,
  ADD COLUMN IF NOT EXISTS video_url text,
  ADD COLUMN IF NOT EXISTS media_url text;

-- Public video playback is enabled by a public bucket. Uploads are
-- restricted to authenticated users writing inside their own UUID folder.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'cozmic-videos',
  'cozmic-videos',
  true,
  524288000,
  ARRAY['video/mp4','video/webm','video/quicktime','video/ogg']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

-- Anyone may read published social posts; video page only displays rows
-- visible through the posts table's SELECT policy.
DROP POLICY IF EXISTS "cozmic posts are readable" ON public.posts;
CREATE POLICY "cozmic posts are readable"
ON public.posts FOR SELECT
TO anon, authenticated
USING (true);

DROP POLICY IF EXISTS "users create their own posts" ON public.posts;
CREATE POLICY "users create their own posts"
ON public.posts FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users update their own posts" ON public.posts;
CREATE POLICY "users update their own posts"
ON public.posts FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users delete their own posts" ON public.posts;
CREATE POLICY "users delete their own posts"
ON public.posts FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Public can watch cozmic videos" ON storage.objects;
CREATE POLICY "Public can watch cozmic videos"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (bucket_id = 'cozmic-videos');

DROP POLICY IF EXISTS "Authenticated users upload own cozmic videos" ON storage.objects;
CREATE POLICY "Authenticated users upload own cozmic videos"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'cozmic-videos'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS "Users delete own cozmic videos" ON storage.objects;
CREATE POLICY "Users delete own cozmic videos"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'cozmic-videos'
  AND (storage.foldername(name))[1] = auth.uid()::text
);
