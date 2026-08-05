import { EraserIcon, LayersIcon, ShrinkIcon, type LucideIcon } from 'lucide-react';

export interface Product {
  slug: string;
  name: string;
  description: string;
  icon: LucideIcon;
}

// Single source of truth for the sidebar nav and the launcher grid. Adding a
// product to the suite is one entry here plus its app/<slug>/page.tsx route —
// nothing else needs editing.
export const PRODUCTS: Product[] = [
  {
    slug: 'compositor',
    name: 'Compositor',
    description: 'Turn a CSV of product image URLs into branded composite tiles.',
    icon: LayersIcon,
  },
  {
    slug: 'bg-remover',
    name: 'BG Remover',
    description: 'Strip backgrounds from product shots, entirely in the browser.',
    icon: EraserIcon,
  },
  {
    slug: 'png-compressor',
    name: 'PNG Compressor',
    description: 'Shrink PNGs locally with pngquant + oxipng — no API key, no upload.',
    icon: ShrinkIcon,
  },
];

export function productHref(product: Product): string {
  return `/${product.slug}`;
}

export function productForPathname(pathname: string): Product | undefined {
  return PRODUCTS.find((product) => {
    const href = productHref(product);
    return pathname === href || pathname.startsWith(`${href}/`);
  });
}
