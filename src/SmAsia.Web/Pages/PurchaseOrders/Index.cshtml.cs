using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;

namespace SmAsia.Web.Pages.PurchaseOrders;

public class IndexModel(AppDbContext db) : PageModel
{
    [BindProperty(SupportsGet = true)] public string Status { get; set; } = "open";
    [BindProperty(SupportsGet = true)] public int? SupplierId { get; set; }
    public List<PurchaseOrder> Orders { get; set; } = [];
    public List<Supplier> Suppliers { get; set; } = [];

    public async Task OnGetAsync()
    {
        var q = db.PurchaseOrders.Include(p => p.Supplier).Include(p => p.Lines).AsQueryable();
        q = Status switch
        {
            "open" => q.Where(p => p.Status == PurchaseOrderStatus.Draft || p.Status == PurchaseOrderStatus.Sent || p.Status == PurchaseOrderStatus.PartiallyReceived),
            "all" => q,
            _ => Enum.TryParse<PurchaseOrderStatus>(Status, true, out var s) ? q.Where(p => p.Status == s) : q,
        };
        if (SupplierId != null) q = q.Where(p => p.SupplierId == SupplierId);
        Orders = await q.OrderByDescending(p => p.OrderDate).ThenByDescending(p => p.Id).Take(300).ToListAsync();
        Suppliers = await db.Suppliers.OrderBy(s => s.Name).ToListAsync();
    }
}
