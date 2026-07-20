const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── GHOST API SCAN MODULE ──────────────────────────────
// Fetches publication data via Ghost Content API and returns
// platform-specific intelligence findings

async function runGhostScan(siteUrl, apiKey) {
  const base = siteUrl.replace(/\/$/, '');
  const results = {
    settings: null,
    postCount: 0,
    pageCount: 0,
    tagCount: 0,
    issues: [],
    stats: {}
  };

  try {
    // ── SETTINGS ────────────────────────────────────────
    const settingsRes = await fetch(
      `${base}/ghost/api/content/settings/?key=${apiKey}`
    );
    if (settingsRes.ok) {
      const settingsData = await settingsRes.json();
      results.settings = settingsData.settings || {};
    }

    // ── POSTS ────────────────────────────────────────────
    let page = 1;
    let allPosts = [];
    while (true) {
      const postsRes = await fetch(
        `${base}/ghost/api/content/posts/?key=${apiKey}&limit=50&page=${page}&fields=id,title,slug,custom_excerpt,meta_description,feature_image,tags,published_at`
      );
      if (!postsRes.ok) break;
      const postsData = await postsRes.json();
      const posts = postsData.posts || [];
      allPosts = allPosts.concat(posts);
      if (posts.length < 50) break;
      page++;
      if (page > 10) break; // safety limit — max 500 posts
    }
    results.postCount = allPosts.length;

    // ── PAGES ────────────────────────────────────────────
    const pagesRes = await fetch(
      `${base}/ghost/api/content/pages/?key=${apiKey}&limit=all&fields=id,title,meta_description,feature_image`
    );
    if (pagesRes.ok) {
      const pagesData = await pagesRes.json();
      results.pageCount = (pagesData.pages || []).length;
    }

    // ── TAGS ─────────────────────────────────────────────
    const tagsRes = await fetch(
      `${base}/ghost/api/content/tags/?key=${apiKey}&limit=all&fields=id,name,meta_description`
    );
    let allTags = [];
    if (tagsRes.ok) {
      const tagsData = await tagsRes.json();
      allTags = tagsData.tags || [];
      results.tagCount = allTags.length;
    }

    // ── ANALYSE ISSUES ────────────────────────────────────

    // 1. Site missing description
    if (!results.settings.description || results.settings.description.trim().length < 10) {
      results.issues.push({
        type: 'site_description',
        severity: 'high',
        title: 'Site description not set',
        desc: 'Your Ghost publication has no site description. This appears in search results and social shares.',
        fix: 'Go to Ghost Admin → Settings → General → Site description and add a compelling description (under 160 characters).',
        count: null
      });
    }

    // 2. Posts missing meta descriptions
    const noMetaPosts = allPosts.filter(function(p) {
      return !p.custom_excerpt && !p.meta_description;
    });
    if (noMetaPosts.length > 0) {
      results.issues.push({
        type: 'posts_no_meta',
        severity: noMetaPosts.length > 5 ? 'high' : 'medium',
        title: noMetaPosts.length + ' post' + (noMetaPosts.length !== 1 ? 's' : '') + ' missing meta description',
        desc: 'Posts without meta descriptions get auto-generated snippets in search results which are rarely optimal.',
        fix: 'In Ghost Admin, open each post → Settings (gear icon) → Meta Data → add a Meta Description. Focus on your most important posts first.',
        count: noMetaPosts.length,
        examples: noMetaPosts.slice(0, 3).map(function(p) { return p.title; })
      });
    }

    // 3. Posts missing feature images
    const noImagePosts = allPosts.filter(function(p) {
      return !p.feature_image;
    });
    if (noImagePosts.length > 0) {
      results.issues.push({
        type: 'posts_no_image',
        severity: noImagePosts.length > 5 ? 'medium' : 'low',
        title: noImagePosts.length + ' post' + (noImagePosts.length !== 1 ? 's' : '') + ' missing feature image',
        desc: 'Posts without feature images look poor when shared on social media and in email newsletters.',
        fix: 'In Ghost Admin, open each post and add a Feature Image at the top of the editor. Use high quality images at least 1200px wide.',
        count: noImagePosts.length,
        examples: noImagePosts.slice(0, 3).map(function(p) { return p.title; })
      });
    }

    // 4. Posts missing tags
    const noTagPosts = allPosts.filter(function(p) {
      return !p.tags || p.tags.length === 0;
    });
    if (noTagPosts.length > 0) {
      results.issues.push({
        type: 'posts_no_tags',
        severity: 'low',
        title: noTagPosts.length + ' post' + (noTagPosts.length !== 1 ? 's' : '') + ' have no tags',
        desc: 'Tags help organise content and improve navigation. Untagged posts are harder for readers to discover.',
        fix: 'In Ghost Admin, open each post → Settings → Tags and add relevant tags.',
        count: noTagPosts.length,
        examples: noTagPosts.slice(0, 3).map(function(p) { return p.title; })
      });
    }

    // 5. Post titles too long
    const longTitlePosts = allPosts.filter(function(p) {
      return p.title && p.title.length > 60;
    });
    if (longTitlePosts.length > 0) {
      results.issues.push({
        type: 'posts_long_titles',
        severity: 'low',
        title: longTitlePosts.length + ' post' + (longTitlePosts.length !== 1 ? 's' : '') + ' have titles over 60 characters',
        desc: 'Search engines truncate titles over 60 characters in search results. Shorter titles display better.',
        fix: 'In Ghost Admin, open each affected post and shorten the title. Alternatively set a separate SEO title in Settings → Meta Data.',
        count: longTitlePosts.length,
        examples: longTitlePosts.slice(0, 3).map(function(p) { return p.title; })
      });
    }

    // 6. Tags missing meta descriptions
    const noMetaTags = allTags.filter(function(t) { return !t.meta_description; });
    if (noMetaTags.length > 0 && allTags.length > 0) {
      results.issues.push({
        type: 'tags_no_meta',
        severity: 'low',
        title: noMetaTags.length + ' tag' + (noMetaTags.length !== 1 ? 's' : '') + ' missing meta description',
        desc: 'Tag pages appear in search results. Without meta descriptions, Google auto-generates them.',
        fix: 'In Ghost Admin → Tags → click each tag → add a Meta Description.',
        count: noMetaTags.length,
        examples: noMetaTags.slice(0, 3).map(function(t) { return t.name; })
      });
    }

    // Stats summary
    results.stats = {
      totalPosts: results.postCount,
      totalPages: results.pageCount,
      totalTags: results.tagCount,
      postsWithMeta: allPosts.length - noMetaPosts.length,
      postsWithImage: allPosts.length - noImagePosts.length,
      postsWithTags: allPosts.length - noTagPosts.length,
      siteTitle: results.settings.title || '',
      siteDescription: results.settings.description || '',
    };

  } catch(err) {
    console.error('Ghost scan error:', err.message);
    results.error = err.message;
  }

  return results;
}

module.exports = { runGhostScan };
