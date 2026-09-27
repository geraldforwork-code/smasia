using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;

namespace SmAsia.Web.Pages.Receiving;

public class IndexModel(AppDbContext db) : PageModel
{
    [BindProperty(SupportsGet = true)] public string? Status { get; set; }
    [BindProperty(SupportsGet = true)] public int? SupplierId { get; set; }
    public List<Receipt> Receipts { get; set; } = [];
    public List<Supplier> Suppliers { get; set; } = [];

    public async Task OnGetAsync()
    {
        var q = db.Receipts.Include(r => r.Supplier).Include(r => r.PurchaseOrder).Include(r => r.Lines).AsQueryable();
        if (Enum.TryParse<ReceiptStatus>(Status, true, out var s)) q = q.Where(r => r.Status == s);
        if (SupplierId != null) q = q.Where(r => r.SupplierId == SupplierId);
        Receipts = await q.OrderByDescending(r => r.ReceivedDate).ThenByDescending(r => r.Id).Take(300).AsSplitQuery().ToListAsync();
        Suppliers = await db.Suppliers.OrderBy(x => x.Name).ToListAsync();
    }
}
