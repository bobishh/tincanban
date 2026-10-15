<script setup lang="ts">
import { artifactKindLabels, type Artifact, type ArtifactInput, type Template } from "../types"
defineProps<{ artifacts: Artifact[]; templates: Template[]; readOnly: boolean; showForm: boolean; error: string }>()
const draft = defineModel<Pick<ArtifactInput, "kind" | "title" | "templateId" | "pdfPath"> & { sourceMarkdownPath: string }>({ required: true })
const emit = defineEmits<{ toggle: []; submit: [] }>()
</script>
<template>
          <section class="detail-section artifacts-section"><div class="section-heading"><div><span class="detail-label">PDF artifacts</span><h3>{{ artifacts.length ? `${artifacts.length} attached` : "No generated PDFs" }}</h3></div><button class="button button-small" type="button" :disabled="readOnly" @click="emit('toggle')">+ PDF</button></div>
            <form v-if="showForm" class="document-form" novalidate @submit.prevent="emit('submit')"><label><span>Kind</span><select v-model="draft.kind" @change="draft.templateId = ''"><option v-for="(label, kind) in artifactKindLabels" :key="kind" :value="kind">{{ label }}</option></select></label><label><span>Title</span><input v-model="draft.title" placeholder="Cleo CV" /></label><label><span>Base template</span><select v-model="draft.templateId"><option value="">Select template</option><option v-for="template in templates" :key="template.id" :value="template.id">{{ template.name }}</option></select></label><label><span>PDF path</span><input v-model="draft.pdfPath" placeholder="/Users/…/cleo-cv.pdf" /></label><label><span>Generated Markdown path</span><input v-model="draft.sourceMarkdownPath" placeholder="/Users/…/cleo-cv.md" /></label><p v-if="error" class="form-error" role="alert">{{ error }}</p><button class="button button-primary" type="submit">Attach PDF</button></form>
            <div v-for="artifact in artifacts" :key="artifact.id" class="document-row"><span class="document-icon">{{ artifact.kind === "cv" ? "CV" : "CL" }}</span><div><strong>{{ artifact.title }}</strong><span>{{ artifactKindLabels[artifact.kind] }} · from template</span></div><a :href="`file://${artifact.pdfPath}`" class="open-path" target="_blank" rel="noopener noreferrer" title="Open PDF">Open PDF</a></div>
          </section>
</template>
