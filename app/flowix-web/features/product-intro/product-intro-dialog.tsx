'use client';

import { Dialog, DialogContent } from '@shared/ui/dialog';
import { ProductIntroContent } from '@features/product-intro/product-intro-content';

export interface ProductIntroDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 产品介绍弹窗 —— 内容全部来自 ProductIntroContent, 这里只负责弹窗外壳。 */
export function ProductIntroDialog({ open, onOpenChange }: ProductIntroDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-none !p-0 w-[calc(100vw-2rem)] sm:w-[60vw] h-[min(84vh,900px)] overflow-hidden">
        <div className="h-full w-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <ProductIntroContent />
        </div>
      </DialogContent>
    </Dialog>
  );
}
