using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;
using SmAsia.Web.Services;
using SmAsia.Web.Services.Parsing;

namespace SmAsia.Web.Pages.Receiving;

public class UploadModel(AppDbContext db, InvoiceParserRegistry parsers, ReceivingService receiving) : PageModel
{
    [BindProperty] public List<IFormFile> Files { get; set; } = [];
    [BindProperty(SupportsGet = true)] public int? PoId { get; set; }
    [BindProperty] public string? ParserKey { get; set; }
    [BindProperty] public bool AllowDuplicate { get; set; }
    [BindProperty] public int ManualSupplierId { get; set; }

    public List<PurchaseOrder> OpenPos { get; set; } = [];
    public List<Supplier> Suppliers { get; set; } = [];
    public IReadOnlyList<IInvoiceParser> Parsers => parsers.Parsers;
    public List<string> Errors { get; } = [];

    public async Task OnGetAsync() => await LoadAsync();

    public async Task<IActionResult> OnPostAsync()
    {
        if (Files.Count == 0) { Errors.Add("Choose one or more invoice PDFs."); await LoadAsync(); return Page(); }

        var created = new List<Receipt>();
        foreach (var file in Files)
        {
            if (!file.FileName.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)) { Errors.Add($"{file.FileName}: not a PDF."); continue; }
            await using var stream = new MemoryStream();
            await file.CopyToAsync(stream);
            stream.Position = 0;

            var (inv, error) = parsers.Parse(stream, string.IsNullOrEmpty(ParserKey) ? null : ParserKey);
            if (inv == null) { Errors.Add($"{file.FileName}: {error}"); continue; }

            var parser = parsers.Parsers.First(p => p.Key == inv.ParserKey);
            var supplier = await receiving.FindOrCreateSupplierAsync(parser);
            var dup = await receiving.FindDuplicateAsync(supplier.Id, inv.InvoiceNumber);
            if (dup != null && !AllowDuplicate)
            {
                Errors.Add($"{file.FileName}: invoice {inv.InvoiceNumber} from {supplier.Name} was already entered (receipt #{dup.Id}, {dup.Status}). Tick \"Allow duplicates\" to import it again.");
                continue;
            }

            int? poId = PoId;
            if (poId != null && !await db.PurchaseOrders.AnyAsync(p => p.Id == poId && p.SupplierId == supplier.Id)) poId = null;
            created.Add(await receiving.CreateFromInvoiceAsync(inv, supplier, file.FileName, poId));
        }

        if (created.Count == 1 && Errors.Count == 0)
            return RedirectToPage("Edit", new { id = created[0].Id });
        if (created.Count > 0)
        {
            TempData["Message"] = $"{created.Count} invoice(s) read. Review each draft and post it to update stock.";
            if (Errors.Count > 0) TempData["Error"] = string.Join("\n", Errors);
            return RedirectToPage("Index", new { status = "Draft" });
        }
        await LoadAsync();
        return Page();
    }

    public async Task<IActionResult> OnPostManualAsync()
    {
        if (ManualSupplierId == 0) { Errors.Add("Choose a supplier for the manual receipt."); await LoadAsync(); return Page(); }
        var receipt = new Receipt { SupplierId = ManualSupplierId, PurchaseOrderId = PoId };
        db.Receipts.Add(receipt);
        await db.SaveChangesAsync();
        return RedirectToPage("Edit", new { id = receipt.Id });
    }

    private async Task LoadAsync()
    {
        OpenPos = await db.PurchaseOrders.Include(p => p.Supplier)
            .Where(p => p.Status == PurchaseOrderStatus.Sent || p.Status == PurchaseOrderStatus.PartiallyReceived)
            .OrderBy(p => p.OrderDate).ToListAsync();
        Suppliers = await db.Suppliers.Where(s => s.IsActive).OrderBy(s => s.Name).ToListAsync();
    }
}
