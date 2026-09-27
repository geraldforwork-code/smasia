using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;
using SmAsia.Web.Services;

namespace SmAsia.Web.Pages.PurchaseOrders;

public class ViewModel(AppDbContext db, ReceivingService receiving) : PageModel
{
    public PurchaseOrder Po { get; set; } = null!;
    public List<Receipt> Receipts { get; set; } = [];

    public async Task<IActionResult> OnGetAsync(int id)
    {
        var po = await db.PurchaseOrders.Include(p => p.Supplier).Include(p => p.Lines).ThenInclude(l => l.Product).FirstOrDefaultAsync(p => p.Id == id);
        if (po == null) return NotFound();
        Po = po;
        Receipts = await db.Receipts.Where(r => r.PurchaseOrderId == id).OrderBy(r => r.CreatedAt).ToListAsync();
        return Page();
    }

    public async Task<IActionResult> OnPostStatusAsync(int id, PurchaseOrderStatus status)
    {
        var po = await db.PurchaseOrders.Include(p => p.Lines).FirstAsync(p => p.Id == id);
        if (status == PurchaseOrderStatus.Sent && po.Lines.Count == 0)
        {
            TempData["Error"] = "Add at least one line before sending.";
            return RedirectToPage(new { id });
        }
        if (status == PurchaseOrderStatus.Draft && po.Lines.Any(l => l.QtyReceivedUnits > 0))
        {
            TempData["Error"] = "Stock has already been received against this PO, so it can't go back to draft.";
            return RedirectToPage(new { id });
        }
        po.Status = status;
        await db.SaveChangesAsync();
        TempData["Message"] = $"{po.PoNumber} marked {status}.";
        return status == PurchaseOrderStatus.Draft ? RedirectToPage("Edit", new { id }) : RedirectToPage(new { id });
    }

    public async Task<IActionResult> OnPostReceiveAsync(int id)
    {
        var existing = await db.Receipts.FirstOrDefaultAsync(r => r.PurchaseOrderId == id && r.Status == ReceiptStatus.Draft);
        if (existing != null) return RedirectToPage("/Receiving/Edit", new { id = existing.Id });
        var receipt = await receiving.CreateFromPurchaseOrderAsync(id);
        TempData["Message"] = "Check the quantities that arrived, then post the receipt.";
        return RedirectToPage("/Receiving/Edit", new { id = receipt.Id });
    }

    public async Task<IActionResult> OnPostDeleteAsync(int id)
    {
        var po = await db.PurchaseOrders.FirstAsync(p => p.Id == id);
        if (po.Status != PurchaseOrderStatus.Draft) { TempData["Error"] = "Only drafts can be deleted — cancel it instead."; return RedirectToPage(new { id }); }
        db.PurchaseOrders.Remove(po);
        await db.SaveChangesAsync();
        TempData["Message"] = $"Deleted {po.PoNumber}.";
        return RedirectToPage("Index");
    }
}
