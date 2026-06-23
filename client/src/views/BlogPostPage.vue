<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowLeft, Calendar, User, ArrowRight } from 'lucide-vue-next'
import Tag from 'primevue/tag'
import { blogPosts } from '@/data/blogPosts'
import { sanitizeHtml } from '@/lib/sanitize'

const route = useRoute()

const post = computed(() => blogPosts.find((p) => p.slug === route.params.slug))

const relatedPosts = computed(() => {
  if (!post.value) return []
  const sameCategory = blogPosts.filter(
    (p) => p.id !== post.value!.id && p.category === post.value!.category
  )
  const others = blogPosts.filter(
    (p) => p.id !== post.value!.id && p.category !== post.value!.category
  )
  return [...sameCategory, ...others].slice(0, 3)
})

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatShortDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Convert plain-text blog content into basic HTML paragraphs.
 * The blog data stores content as plain text with double-newline paragraph breaks,
 * markdown-style bold (**text**), and bullet lists (- item).
 */
function contentToHtml(content: string): string {
  const paragraphs = content.split('\n\n')
  const htmlParts = paragraphs.map((para) => {
    // Heading: **Bold text** on its own line
    if (para.startsWith('**') && para.endsWith('**') && !para.slice(2, -2).includes('**')) {
      return `<h2>${para.replace(/\*\*/g, '')}</h2>`
    }
    // Bullet list
    if (para.startsWith('- ')) {
      const items = para.split('\n').map((line) => `<li>${boldify(line.replace(/^- /, ''))}</li>`)
      return `<ul>${items.join('')}</ul>`
    }
    // Mixed: text followed by bullets
    if (para.includes('\n- ')) {
      const lines = para.split('\n')
      const textLine = lines[0]
      const items = lines.slice(1).map((line) => `<li>${boldify(line.replace(/^- /, ''))}</li>`)
      return `<p>${boldify(textLine)}</p><ul>${items.join('')}</ul>`
    }
    // Regular paragraph
    return `<p>${boldify(para)}</p>`
  })
  return htmlParts.join('')
}

function boldify(text: string): string {
  return text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
}
</script>

<template>
  <div class="min-h-screen">
    <!-- Post Found -->
    <div v-if="post" class="pt-10 pb-20 px-4 md:px-8">
      <div class="max-w-screen-2xl mx-auto">
        <!-- Back Link -->
        <router-link
          to="/blog"
          class="inline-flex items-center gap-1 text-sm font-geist text-slate-500 hover:text-indigo-600 transition-colors mb-8"
        >
          <ArrowLeft class="w-4 h-4" /> Back to blog
        </router-link>

        <div class="grid lg:grid-cols-4 gap-12">
          <!-- Article -->
          <article class="lg:col-span-3">
            <!-- Article Header -->
            <header class="mb-8">
              <div class="flex flex-wrap items-center gap-3 mb-4">
                <Tag :value="post.category" severity="info" />
                <span class="text-sm font-geist text-slate-400 flex items-center gap-1">
                  <Calendar class="w-3.5 h-3.5" />
                  {{ formatDate(post.date) }}
                </span>
                <span
                  v-if="post.author"
                  class="text-sm font-geist text-slate-400 flex items-center gap-1"
                >
                  <User class="w-3.5 h-3.5" />
                  {{ post.author }}
                </span>
              </div>
              <h1 class="text-2xl sm:text-3xl md:text-4xl font-jakarta font-bold text-slate-900 leading-tight">
                {{ post.title }}
              </h1>
            </header>

            <!-- Article Content -->
            <div
              class="prose prose-slate max-w-none font-geist
                prose-headings:font-jakarta prose-headings:font-bold prose-headings:text-slate-900
                prose-p:text-slate-600 prose-p:leading-relaxed prose-p:text-[15px]
                prose-li:text-slate-600 prose-li:text-[15px]
                prose-strong:text-slate-800
                prose-a:text-indigo-600 prose-a:no-underline hover:prose-a:underline"
              v-html="sanitizeHtml(contentToHtml(post.content))"
            />
          </article>

          <!-- Sidebar -->
          <aside class="lg:col-span-1">
            <div class="sticky top-28 space-y-6">
              <!-- Related Posts -->
              <div class="bg-slate-50 rounded-2xl p-6 border border-slate-100">
                <h2 class="font-jakarta font-semibold text-slate-900 mb-4">Related Posts</h2>
                <div class="space-y-4">
                  <router-link
                    v-for="related in relatedPosts"
                    :key="related.id"
                    :to="`/blog/${related.slug}`"
                    class="block group"
                  >
                    <div class="text-xs font-geist text-slate-400 mb-1">
                      {{ formatShortDate(related.date) }}
                    </div>
                    <div class="text-sm font-geist font-medium text-slate-700 group-hover:text-indigo-600 transition-colors line-clamp-2">
                      {{ related.title }}
                    </div>
                  </router-link>
                </div>
              </div>

              <!-- CTA Card -->
              <router-link
                to="/blog"
                class="block bg-indigo-50 border border-indigo-100 rounded-2xl p-6 hover:bg-indigo-100 transition-colors"
              >
                <h3 class="font-jakarta font-semibold text-slate-900 mb-1">Browse All Posts</h3>
                <p class="text-xs font-geist text-slate-600 mb-3">Explore more articles and updates from our blog.</p>
                <span class="text-sm font-geist font-medium text-indigo-600 flex items-center gap-1">
                  View all <ArrowRight class="w-3.5 h-3.5" />
                </span>
              </router-link>
            </div>
          </aside>
        </div>
      </div>
    </div>

    <!-- 404 State -->
    <div v-else class="pt-10 pb-20 px-4 md:px-8 text-center">
      <h1 class="text-3xl font-jakarta font-bold text-slate-900 mb-4">Post not found</h1>
      <p class="text-slate-500 font-geist mb-6">The blog post you are looking for does not exist or has been removed.</p>
      <router-link
        to="/blog"
        class="inline-flex items-center gap-1 text-indigo-600 font-geist hover:underline"
      >
        <ArrowLeft class="w-4 h-4" /> Back to blog
      </router-link>
    </div>
  </div>
</template>
