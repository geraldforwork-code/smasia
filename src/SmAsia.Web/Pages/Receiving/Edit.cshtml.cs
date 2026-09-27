using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;
using SmAsia.Web.Services;

namespace SmAsia.Web.Pages.Receiving;

public class EditModel(AppDbContext db, ReceivingService receiving) : PageModel
{
    public class LineInput
    {
        public int Id { get; set; }
        public int? ProductId { get; set; }
        public string? ProductLabel { get; set; }
        public string? SupplierItemCode { get; set; }
        public string Description { get; set; } = "";
        public string? Upc { get; set; }
        public decimal QtyCases { get; set; }
        public int UnitsPerCase { get; set; } = 1;
        public decimal CaseCost { get; set; }
        public DateOnly? ExpiryDate { get; set; }
        public bool Skip { get; set; }
        public bool CreateNew { get; set; }
        public string? MatchMethod { get; set; }
        public decimal? ProductOnHand { get; set; }
    }

    public Receipt Receipt { get; set; } = null!;
    [BindProperty] public DateOnly ReceivedDate { get; set; }
    [BindProperty] public string? InvoiceNumber { get; set; }
    [BindProperty] public DateOnly? InvoiceDate { get; set; }
    [BindProperty] public int? PurchaseOrderId { get; set; }
    [BindProperty] public decimal? InvoiceSubtotal { get; set; }
    [BindProperty] public decimal? InvoiceTax { get; set; }
    [BindProperty] public decimal? InvoiceTotal { get; set; }
    [BindProperty] public int? NewProductCategoryId { get; set; }
    [BindProperty] public List<LineInput> Lines { get; set; } = [];
    [BindProperty] public int? AddProductId { get; set; }

    public List<PurchaseOrder> OpenPos { get; set; } = [];
    public List<Category> Categories { get; set; } = [];
    public bool IsPosted => Receipt.Status == ReceiptStatus.Posted;

    public async Task<IActionResult> OnGetAsync(int id)
    {
        if (!await LoadAsync(id)) return NotFound();
        ReceivedDate = Receipt.ReceivedDate; InvoiceNumber = Receipt.InvoiceNumber; InvoiceDate = Receipt.InvoiceDate;
        PurchaseOrderId = Receipt.PurchaseOrderId; InvoiceSubtotal = Receipt.InvoiceSubtotal; InvoiceTax = Receipt.InvoiceTax; InvoiceTotal = Receipt.InvoiceTotal;
        Lines = Receipt.Lines.OrderBy(l => l.LineNo).Select(l => new LineInput
        {
            Id = l.Id, ProductId = l.ProductId, ProductLabel = l.Product != null ? $"{l.Product.Name} (#{l.Product.Id})" : null,
            SupplierItemCode = l.SupplierItemCode, Description = l.Description, Upc = l.Upc, QtyCases = l.QtyCases,
            UnitsPerCase = l.UnitsPerCase, CaseCost = l.CaseCost, ExpiryDate = l.ExpiryDate, Skip = l.Skip,
            MatchMethod = l.MatchMethod, ProductOnHand = l.Product?.QtyOnHand,
        }).ToList();
        return Page();
    }

    public async Task<IActionResult> OnPostAsync(int id, string? action)
    {
        var receipt = await db.Receipts.Include(r => r.Lines).FirstOrDefaultAsync(r => r.Id == id);
        if (receipt == null) return NotFound();
        if (receipt.Status == ReceiptStatus.Posted) return RedirectToPage(new { id });

        receipt.ReceivedDate = ReceivedDate;
        receipt.InvoiceNumber = InvoiceNumber;
        receipt.InvoiceDate = InvoiceDate;
        receipt.PurchaseOrderId = PurchaseOrderId;
        receipt.InvoiceSubtotal = InvoiceSubtotal;
        receipt.InvoiceTax = InvoiceTax;
        receipt.InvoiceTotal = InvoiceTotal;

        foreach (var input in Lines)
        {
            var line = receipt.Lines.FirstOrDefault(l => l.Id == input.Id);
            if (line == null) continue;
            if (input.ProductId != line.ProductId) line.MatchMethod = input.ProductId == null ? null : "Manual";
            line.ProductId = input.ProductId;
            line.SupplierItemCode = input.SupplierItemCode;
            line.Description = input.Description;
            line.Upc = input.Upc;
            line.QtyCases = input.QtyCases;
            line.UnitsPerCase = Math.Max(1, input.UnitsPerCase);
            line.CaseCost = input.CaseCost;
            line.ExtendedCost = Math.Round(input.QtyCases * input.CaseCost, 2);
            line.ExpiryDate = input.ExpiryDate;
            line.Skip = input.Skip;

            if (input.CreateNew && line.ProductId == null && !line.Skip)
            {
                var product = new Product
                {
                    Name = line.Description,
                    Barcode = string.IsNullOrWhiteSpace(line.Upc) || line.Upc.Length < 8 ? null : line.Upc,
                    UnitsPerCase = line.UnitsPerCase,
                    UnitCost = Math.Round(line.CaseCost / line.UnitsPerCase, 4),
                    CategoryId = NewProductCategoryId,
                    PreferredSupplierId = receipt.SupplierId,
                };
                db.Products.Add(product);
                line.Product = product;
                line.MatchMethod = "New product";
            }
        }

        if (action?.StartsWith("delete-line:") == true && int.TryParse(action["delete-line:".Length..], out var delId))
        {
            var del = receipt.Lines.FirstOrDefault(l => l.Id == delId);
            if (del != null) db.ReceiptLines.Remove(del);
        }

        if (AddProductId is { } pid)
        {
            var p = await db.Products.FindAsync(pid);
            if (p != null)
            {
                var sp = await db.SupplierProducts.FirstOrDefaultAsync(s => s.ProductId == pid && s.SupplierId == receipt.SupplierId);
                var upc = Math.Max(1, sp?.UnitsPerCase ?? p.UnitsPerCase);
                var cost = sp?.LastCaseCost ?? Math.Round(p.UnitCost * upc, 2);
                receipt.Lines.Add(new ReceiptLine
                {
                    LineNo = receipt.Lines.Count == 0 ? 1 : receipt.Lines.Max(l => l.LineNo) + 1,
                    ProductId = pid, Description = p.Name, Upc = p.Barcode, SupplierItemCode = sp?.SupplierItemCode,
                    QtyCases = 1, UnitsPerCase = upc, CaseCost = cost, ExtendedCost = cost, MatchMethod = "Manual",
                });
            }
        }

        await db.SaveChangesAsync();

        if (action == "post")
        {
            var errors = await receiving.PostAsync(id);
            if (errors.Count > 0) { TempData["Error"] = string.Join("\n", errors); return RedirectToPage(new { id }); }
            TempData["Message"] = "Receipt posted — stock and costs updated.";
            return RedirectToPage(new { id });
        }
        TempData["Message"] = "Draft saved.";
        return RedirectToPage(new { id });
    }

    public async Task<IActionResult> OnPostDeleteAsync(int id)
    {
        var receipt = await db.Receipts.FirstOrDefaultAsync(r => r.Id == id);
        if (receipt == null) return NotFound();
        if (receipt.Status == ReceiptStatus.Posted) { TempData["Error"] = "Posted receipts can't be deleted. Use a stock adjustment to correct quantities."; return RedirectToPage(new { id }); }
        db.Receipts.Remove(receipt);
        await db.SaveChangesAsync();
        TempData["Message"] = "Draft receipt deleted.";
        return RedirectToPage("Index");
    }

    private async Task<bool> LoadAsync(int id)
    {
        var r = await db.Receipts.Include(x => x.Supplier).Include(x => x.PurchaseOrder)
            .Include(x => x.Lines).ThenInclude(l => l.Product)
            .FirstOrDefaultAsync(x => x.Id == id);
        if (r == null) return false;
        Receipt = r;
        OpenPos = await db.PurchaseOrders.Where(p => p.SupplierId == r.SupplierId && (p.Id == r.PurchaseOrderId || p.Status == PurchaseOrderStatus.Sent || p.Status == PurchaseOrderStatus.PartiallyReceived))
            .OrderByDescending(p => p.OrderDate).ToListAsync();
        Categories = await db.Categories.OrderBy(c => c.Name).ToListAsync();
        return true;
    }
}
