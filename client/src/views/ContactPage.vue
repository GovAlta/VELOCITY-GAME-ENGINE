<!-- TODO: Replace placeholder contact details (hello@example.com, social links) with real values -->
<script setup lang="ts">
import { ref } from 'vue'
import { Mail, MapPin, Twitter, Github, Send } from 'lucide-vue-next'
import { FormKit } from '@formkit/vue'
import Message from 'primevue/message'
import { useNotifications } from '@/composables/useNotifications'

const { success, error: notifyError } = useNotifications()
const submitted = ref(false)
const submitting = ref(false)

async function onSubmit(_data: Record<string, unknown>) {
  submitting.value = true
  try {
    // Wire to api.post('/contact', data) when backend is ready
    submitted.value = true
    success('Message sent', 'We will get back to you shortly.')
  } catch {
    notifyError('Send failed', 'Could not send your message. Please try again.')
  } finally {
    submitting.value = false
  }
}

function resetForm() {
  submitted.value = false
}
</script>

<template>
  <div class="min-h-screen">
    <!-- Page Header -->
    <header class="pt-10 pb-8 px-4 md:px-8">
      <div class="max-w-screen-2xl mx-auto text-center">
        <Mail class="w-10 h-10 text-indigo-600 mx-auto mb-4" />
        <h1 class="text-3xl sm:text-4xl font-jakarta font-bold text-slate-900 mb-4">Get in Touch</h1>
        <p class="text-lg text-slate-600 font-geist max-w-2xl mx-auto">
          Have a question or want to work together? We would love to hear from you.
        </p>
      </div>
    </header>

    <section class="px-4 md:px-8 pb-20">
      <div class="max-w-5xl mx-auto">
        <div class="grid lg:grid-cols-5 gap-10">
          <!-- Left Column: Form -->
          <div class="lg:col-span-3">
            <!-- Success State -->
            <div v-if="submitted" class="border border-slate-200 rounded-2xl p-8">
              <Message severity="success" :closable="false" class="mb-6">
                Your message has been sent successfully. We will get back to you soon.
              </Message>
              <div class="text-center">
                <h2 class="text-xl font-jakarta font-bold text-slate-900 mb-2">Thank you!</h2>
                <p class="text-sm text-slate-500 font-geist mb-4">We typically respond within 1-2 business days.</p>
                <button
                  class="text-sm font-geist text-indigo-600 hover:text-indigo-700 font-medium"
                  @click="resetForm"
                >
                  Send another message
                </button>
              </div>
            </div>

            <!-- Contact Form -->
            <div v-else class="border border-slate-200 rounded-2xl p-5 sm:p-8">
              <FormKit
                type="form"
                :actions="false"
                aria-label="Contact form"
                data-testid="contact-form"
                @submit="onSubmit"
              >
                <div class="space-y-5">
                  <FormKit
                    type="text"
                    name="name"
                    label="Name"
                    placeholder="Your name"
                    validation="required"
                  />
                  <FormKit
                    type="email"
                    name="email"
                    label="Email"
                    placeholder="you@example.com"
                    validation="required|email"
                  />
                  <FormKit
                    type="text"
                    name="subject"
                    label="Subject"
                    placeholder="What is this about?"
                    validation="required"
                  />
                  <FormKit
                    type="textarea"
                    name="message"
                    label="Message"
                    placeholder="Tell us more..."
                    :rows="6"
                    validation="required|length:10,500"
                  />
                  <button
                    type="submit"
                    :disabled="submitting"
                    class="w-full flex items-center justify-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-xl text-sm font-geist font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="contact-submit"
                  >
                    <Send v-if="!submitting" class="w-4 h-4" />
                    {{ submitting ? 'Sending...' : 'Send Message' }}
                  </button>
                </div>
              </FormKit>
            </div>
          </div>

          <!-- Right Column: Info Cards -->
          <div class="lg:col-span-2 space-y-5">
            <!-- Email Card -->
            <div class="border border-slate-200 rounded-2xl p-6">
              <div class="flex items-center gap-3 mb-3">
                <div class="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center">
                  <Mail class="w-5 h-5 text-indigo-600" />
                </div>
                <h3 class="font-jakarta font-semibold text-slate-900">Email</h3>
              </div>
              <a
                href="mailto:hello@example.com"
                class="text-sm font-geist text-indigo-600 hover:text-indigo-700"
              >
                hello@example.com
              </a>
              <p class="text-xs text-slate-400 font-geist mt-1">We typically respond within 1-2 business days.</p>
            </div>

            <!-- Location Card -->
            <div class="border border-slate-200 rounded-2xl p-6">
              <div class="flex items-center gap-3 mb-3">
                <div class="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center">
                  <MapPin class="w-5 h-5 text-indigo-600" />
                </div>
                <h3 class="font-jakarta font-semibold text-slate-900">Location</h3>
              </div>
              <p class="text-sm font-geist text-slate-600">123 Main Street</p>
              <p class="text-sm font-geist text-slate-600">San Francisco, CA 94102</p>
            </div>

            <!-- Social Links Card -->
            <div class="border border-slate-200 rounded-2xl p-6">
              <h3 class="font-jakarta font-semibold text-slate-900 mb-4">Follow Us</h3>
              <div class="flex gap-3">
                <a
                  href="#"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="GitHub"
                  class="p-3 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                >
                  <Github class="w-5 h-5 text-slate-600" />
                </a>
                <a
                  href="#"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Twitter"
                  class="p-3 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                >
                  <Twitter class="w-5 h-5 text-slate-600" />
                </a>
                <a
                  href="mailto:hello@example.com"
                  aria-label="Email"
                  class="p-3 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                >
                  <Mail class="w-5 h-5 text-slate-600" />
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
