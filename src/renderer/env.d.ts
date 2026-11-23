/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

import type { TAAPIType } from '../preload';

declare global {
  interface Window {
    api: TAAPIType;
  }
}

export {};
