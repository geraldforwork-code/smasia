using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;
using SmAsia.Web.Services;

namespace SmAsia.Web.Pages.PurchaseOrders;

public class EditModel(AppDbContext db, PurchasingService purchasing) : PageModel
{
    public class LineInput
    {
        public int Id { get; set; }
        public int ProductId { get; set; }
        public string? ProductName { get; set; }
        public string? SupplierItemCode { get; set; }
        public decimal QtyCases { get; set; }
        public int UnitsPerCase { get; set; } = 1;
        public decimal CaseCost { get; set; }
        public decimal QtyOnHand { get; set; }
        public bool Remove { get; set; }
    }

    [BindProperty] public int Id { get; set; }
    [BindProperty] public int SupplierId { get; set; }
    [BindProperty] public DateOnly OrderDate { get; set; } = DateOnly.FromDateTime(DateTime.Today);
    [BindProperty] public DateOnly? ExpectedDate { get; set; }
    [BindProperty] public string? Notes { get; set; }
    [BindProperty] public List<LineInput> Lines { get; set; } = [];
    [BindProperty] public int? AddProductId { get; set; }
    [BindProperty] public decimal? AddCases { get; set; }

    public string? PoNumber { get; set; }
    public List<Supplier> Suppliers { get; set; } = [];

    public async Task<IActionResult> OnGetAsync(int? id, int? supplierId, int? productId)
    {
        if (id != null)
        {
            var po = await db.PurchaseOrders.Include(p => p.Lines).ThenInclude(l => l.Product).FirstOrDefaultAsync(p => p.Id == id);
            if (po == null) return NotFound();
            if (po.Status != PurchaseOrderStatus.Draft) return RedirectToPage("View", new { id });
            Id = po.Id; PoNumber = po.PoNumber; SupplierId = po.SupplierId; OrderDate = po.OrderDate; ExpectedDate = po.ExpectedDate; Notes = po.Notes;
            Lines = po.Lines.OrderBy(l => l.Product.Name).Select(l => new LineInput
            {
                Id = l.Id, ProductId = l.ProductId, ProductName = l.Product.Name, SupplierItemCode = l.SupplierItemCode,
                QtyCases = l.QtyCases, UnitsPerCase = l.UnitsPerCase, CaseCost = l.CaseCost, QtyOnHand = l.Product.QtyOnHand,
            }).ToList();
        }
        else
        {
            if (productId != null)
            {
                var p = await db.Products.FindAsync(productId);
                if (p != null)
                {
                    supplierId ??= p.PreferredSupplierId;
                    AddProductId = p.Id;
                }
            }
            SupplierId = supplierId ?? 0;
            if (AddProductId != null && SupplierId != 0) Lines.Add(await NewLineAsync(AddProductId.Value, 1));
            AddProductId = null;
        }
        Suppliers = await db.Suppliers.Where(s => s.IsActive || s.Id == SupplierId).OrderBy(s => s.Name).ToListAsync();
        return Page();
    }

    public async Task<IActionResult> OnPostAsync(string? then)
    {
        if (SupplierId == 0)
        {
            TempData["Error"] = "Choose a supplier.";
            Suppliers = await db.Suppliers.OrderBy(s => s.Name).ToListAsync();
            return Page();
        }
        var supplier = await db.Suppliers.FindAsync(SupplierId);

        PurchaseOrder po;
        if (Id == 0)
        {
            po = new PurchaseOrder { PoNumber = await purchasing.NextPoNumberAsync() };
            db.PurchaseOrders.Add(po);
        }
        else
        {
            po = await db.PurchaseOrders.Include(p => p.Lines).FirstAsync(p => p.Id == Id);
            if (po.Status != PurchaseOrderStatus.Draft) return RedirectToPage("View", new { id = Id });
        }
        po.SupplierId = SupplierId;
        po.OrderDate = OrderDate;
        po.ExpectedDate = ExpectedDate ?? OrderDate.AddDays(supplier?.LeadTimeDays ?? 7);
        po.Notes = Notes;

        foreach (var input in Lines)
        {
            var line = po.Lines.FirstOrDefault(l => l.Id == input.Id && input.Id != 0);
            if (input.Remove || input.QtyCases <= 0)
            {
                if (line != null) db.PurchaseOrderLines.Remove(line);
                continue;
            }
            if (line == null) { line = new PurchaseOrderLine { ProductId = input.ProductId }; po.Lines.Add(line); }
            line.QtyCases = input.QtyCases;
            line.UnitsPerCase = Math.Max(1, input.UnitsPerCase);
            line.CaseCost = input.CaseCost;
            line.SupplierItemCode = input.SupplierItemCode;
        }

        if (AddProductId is { } addId)
        {
            var existing = po.Lines.FirstOrDefault(l => l.ProductId == addId);
            if (existing != null) existing.QtyCases += AddCases ?? 1;
            else
            {
                var li = await NewLineAsync(addId, AddCases ?? 1);
                po.Lines.Add(new PurchaseOrderLine { ProductId = addId, QtyCases = li.QtyCases, UnitsPerCase = li.UnitsPerCase, CaseCost = li.CaseCost, SupplierItemCode = li.SupplierItemCode });
            }
        }

        await db.SaveChangesAsync();
        if (then == "view") return RedirectToPage("View", new { id = po.Id });
        TempData["Message"] = $"Saved {po.PoNumber}.";
        return RedirectToPage("Edit", new { id = po.Id });
    }

    private async Task<LineInput> NewLineAsync(int productId, decimal cases)
    {
        var p = await db.Products.FindAsync(productId) ?? throw new InvalidOperationException("Product not found");
        var sp = await db.SupplierProducts.FirstOrDefaultAsync(s => s.ProductId == productId && s.SupplierId == SupplierId);
        var upc = Math.Max(1, sp?.UnitsPerCase ?? p.UnitsPerCase);
        return new LineInput
        {
            ProductId = p.Id, ProductName = p.Name, SupplierItemCode = sp?.SupplierItemCode, QtyCases = cases,
            UnitsPerCase = upc, CaseCost = sp?.LastCaseCost ?? Math.Round(p.UnitCost * upc, 2), QtyOnHand = p.QtyOnHand,
        };
    }
}
