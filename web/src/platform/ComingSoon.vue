<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Construction } from 'lucide-vue-next';
import EmptyState from '@/design/EmptyState.vue';
const { t } = useI18n();
</script>

<template>
  <EmptyState :icon="Construction" :title="t('soon.title')" :text="t('soon.text')" />
</template>
