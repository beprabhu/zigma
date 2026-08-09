import Link from 'next/link';
import { ArrowRightIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { HintCardHeader } from '@/components/hint-card-header';
import { PRODUCTS, productHref } from '@/lib/products';

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="mx-auto w-full max-w-3xl px-5 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Zigma</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Internal image tooling for the Zepto catalogue. Pick a tool to get started.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {PRODUCTS.map((product) => (
            <Card key={product.slug}>
              <HintCardHeader
                title={
                  <span className="flex items-center gap-2">
                    <product.icon className="size-4 text-primary" />
                    {product.name}
                  </span>
                }
                hint={product.description}
              />
              <CardContent>
                {/* nativeButton={false}: the rendered element is an <a>, and Base
                    UI logs a dev error if it still assumes a native <button>. */}
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={<Link href={productHref(product)} />}
                >
                  Open {product.name}
                  <ArrowRightIcon data-icon="inline-end" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
