using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;
using SmAsia.Web.Services;
using SmAsia.Web.Services.Forecasting;

namespace SmAsia.Web.Pages.Forecast;

public class IndexModel(AppDbContext db, ForecastService forecasts, PurchasingService purchasing) : PageModel
{
    [BindProperty(SupportsGet = true)] public int? SupplierId { get; set; }
    [BindProperty(SupportsGet = true)] public int? CategoryId { get; set; }
    [BindProperty(SupportsGet = true)] public bool NeedsOrder { get; set; }
    [BindProperty(SupportsGet = true)] public string? Q { get; set; }
    [BindProperty(SupportsGet = true)] public string Sort { get; set; } = "cover";

    public class OrderInput
    {
        public int ProductId { get; set; }
        public int? SupplierId { get; set; }
        public decimal Cases { get; set; }
        public bool Selected { get; set; }
    }
    [BindProperty] public List<OrderInput> Orders { get; set; } = [];
    [BindProperty] public int? FallbackSupplierId { get; set; }

    public List<ForecastRow> Rows { get; set; } = [];
    public List<Supplier> Suppliers { get; set; } = [];
    public List<Category> Categories { get; set; } = [];
    public (DateOnly First, DateOnly Last)? SalesRange { get; set; }
    public ForecastSettings Settings => forecasts.Settings;

    public async Task OnGetAsync()
    {
        var rows = await forecasts.BuildAsync(supplierId: SupplierId, categoryId: CategoryId);
        if (NeedsOrder) rows = rows.Where(r => r.Advice.SuggestedUnits > 0).ToList();
        if (!string.IsNullOrWhiteSpace(Q)) rows = rows.Where(r => r.Product.Name.Contains(Q, StringComparison.OrdinalIgnoreCase) || (r.Product.Barcode?.Contains(Q) ?? false)).ToList();
        Rows = Sort switch
        {
            "name" => rows.OrderBy(r => r.Product.Name).ToList(),
            "demand" => rows.OrderByDescending(r => r.Forecast.DailyRate).ToList(),
            "supplier" => rows.OrderBy(r => r.Supplier?.Name ?? "~").ThenBy(r => r.Product.Name).ToList(),
            _ => rows.OrderBy(r => r.Advice.SuggestedUnits > 0 ? 0 : 1).ThenBy(r => r.Advice.DaysOfCover ?? double.MaxValue).ThenBy(r => r.Product.Name).ToList(),
        };
        if (Rows.Count > 500 && !NeedsOrder) Rows = Rows.Take(500).ToList();
        Orders = Rows.Select(r => new OrderInput
        {
            ProductId = r.Product.Id, SupplierId = r.Supplier?.Id, Cases = r.Advice.SuggestedCases, Selected = r.Advice.SuggestedCases > 0,
        }).ToList();
        Suppliers = await db.Suppliers.Where(s => s.IsActive).OrderBy(s => s.Name).ToListAsync();
        Categories = await db.Categories.OrderBy(c => c.Name).ToListAsync();
        SalesRange = await forecasts.SalesRangeAsync();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        var picked = Orders.Where(o => o.Selected && o.Cases > 0).ToList();
        if (picked.Count == 0)
        {
            TempData["Error"] = "Tick at least one product with a quantity to order.";
            return RedirectToPage(new { SupplierId, CategoryId, NeedsOrder, Q, Sort });
        }
        var missing = picked.Where(o => (o.SupplierId ?? FallbackSupplierId) == null).ToList();
        if (missing.Count > 0)
        {
            TempData["Error"] = $"{missing.Count} selected product(s) have no supplier. Choose a supplier for them at the bottom of the page, or set a preferred supplier on the product.";
            return RedirectToPage(new { SupplierId, CategoryId, NeedsOrder, Q, Sort });
        }
        var pos = await purchasing.CreateDraftsAsync(picked.Select(o => (o.ProductId, (o.SupplierId ?? FallbackSupplierId)!.Value, o.Cases)));
        TempData["Message"] = $"Created {pos.Count} draft purchase order(s): {string.Join(", ", pos.Select(p => p.PoNumber))}. Review and send them.";
        return pos.Count == 1 ? RedirectToPage("/PurchaseOrders/Edit", new { id = pos[0].Id }) : RedirectToPage("/PurchaseOrders/Index", new { status = "Draft" });
    }
}
