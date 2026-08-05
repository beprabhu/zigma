'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BoxesIcon } from 'lucide-react';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { ThemeToggle } from '@/components/theme-toggle';
import { PRODUCTS, productForPathname, productHref } from '@/lib/products';

export function AppSidebar() {
  const pathname = usePathname();
  const current = productForPathname(pathname);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        {/* size-8 is exactly the content width left inside the 3rem icon rail
            after SidebarHeader's p-2, so the mark survives collapse untouched. */}
        <Link href="/" className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <BoxesIcon className="size-4" />
          </span>
          <span className="grid min-w-0 leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-semibold">Zesku</span>
            <span className="truncate text-xs text-sidebar-foreground/70">Internal tools</span>
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Products</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {PRODUCTS.map((product) => (
                <SidebarMenuItem key={product.slug}>
                  <SidebarMenuButton
                    isActive={current?.slug === product.slug}
                    tooltip={product.name}
                    render={<Link href={productHref(product)} />}
                  >
                    <product.icon />
                    <span>{product.name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center justify-between gap-2 group-data-[collapsible=icon]:justify-center">
          <span className="text-xs text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden">
            Theme
          </span>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
