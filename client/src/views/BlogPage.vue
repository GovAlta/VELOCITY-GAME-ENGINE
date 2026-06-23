<script setup lang="ts">
import { computed } from 'vue'
import { Calendar, ArrowRight, Newspaper } from 'lucide-vue-next'
import Tag from 'primevue/tag'
import { blogPosts } from '@/data/blogPosts'

const featuredPost = computed(() => blogPosts.find((p) => p.featured) || blogPosts[0])

const remainingPosts = computed(() => blogPosts.filter((p) => p.id !== featuredPost.value.id))

function formatDate(date: string, style: 'long' | 'short' = 'long') {
  const options: Intl.DateTimeFormatOptions =
    style === 'long'
      ? { month: 'long', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }
  return new Date(date).toLocaleDateString('en-US', options)
}
</script>

<template>
  <div class="min-h-screen">
    <!-- Page Header -->
    <header class="pt-10 pb-8 px-4 md:px-8">
      <div class="max-w-screen-2xl mx-auto">
        <div class="flex items-center gap-3 mb-4">
          <Newspaper class="w-8 h-8 text-indigo-600" />
          <h1 class="text-3xl sm:text-4xl font-jakarta font-bold text-slate-900">Blog</h1>
        </div>
        <p class="text-lg text-slate-600 font-geist max-w-3xl">
          Updates, insights, and news from our team.
        </p>
      </div>
    </header>

    <section class="px-4 md:px-8 pb-20">
      <div class="max-w-screen-2xl mx-auto">
        <!-- Featured Post -->
        <router-link
          :to="`/blog/${featuredPost.slug}`"
          class="block mb-10 group"
        >
          <div class="bg-slate-50 rounded-3xl overflow-hidden border border-slate-100 hover:shadow-lg transition-all hover:border-indigo-200">
            <!-- Image Placeholder -->
            <div class="h-48 sm:h-64 bg-gradient-to-br from-indigo-100 to-slate-100 flex items-center justify-center">
              <Newspaper class="w-16 h-16 text-indigo-300" />
            </div>
            <div class="p-5 sm:p-8 md:p-10">
              <div class="flex items-center gap-3 mb-4">
                <Tag :value="featuredPost.category" severity="info" />
                <span class="text-sm font-geist text-slate-400 flex items-center gap-1">
                  <Calendar class="w-3.5 h-3.5" />
                  {{ formatDate(featuredPost.date) }}
                </span>
              </div>
              <h2 class="text-2xl md:text-3xl font-jakarta font-bold text-slate-900 mb-3 group-hover:text-indigo-600 transition-colors">
                {{ featuredPost.title }}
              </h2>
              <p class="text-slate-600 font-geist leading-relaxed max-w-3xl mb-4">
                {{ featuredPost.excerpt }}
              </p>
              <span class="inline-flex items-center gap-1 text-sm font-geist font-medium text-indigo-600">
                Read more <ArrowRight class="w-4 h-4" />
              </span>
            </div>
          </div>
        </router-link>

        <!-- Post Grid -->
        <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          <router-link
            v-for="post in remainingPosts"
            :key="post.id"
            :to="`/blog/${post.slug}`"
            class="group border border-slate-200 rounded-2xl overflow-hidden hover:shadow-lg transition-all hover:border-indigo-200"
          >
            <!-- Card Image Placeholder -->
            <div class="h-36 bg-gradient-to-br from-slate-100 to-slate-50 flex items-center justify-center">
              <Newspaper class="w-10 h-10 text-slate-300" />
            </div>
            <div class="p-6">
              <div class="flex items-center gap-2 mb-3">
                <Tag :value="post.category" severity="info" size="small" />
                <span class="text-xs font-geist text-slate-400">
                  {{ formatDate(post.date, 'short') }}
                </span>
              </div>
              <h3 class="font-jakarta font-bold text-lg text-slate-900 mb-2 group-hover:text-indigo-600 transition-colors">
                {{ post.title }}
              </h3>
              <p class="text-sm font-geist text-slate-500 leading-relaxed line-clamp-3">
                {{ post.excerpt }}
              </p>
              <span class="inline-flex items-center gap-1 text-sm font-geist font-medium text-indigo-600 mt-4">
                Read more <ArrowRight class="w-3.5 h-3.5" />
              </span>
            </div>
          </router-link>
        </div>
      </div>
    </section>
  </div>
</template>
