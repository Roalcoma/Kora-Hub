export type Option<V extends string = string> = { value: V; label: string; hint?: string };
export type MenuItem = { label: string; icon?: import('vue').Component; danger?: boolean; action: () => void };
