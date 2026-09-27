using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;

namespace SmAsia.Web.Pages.Stock;

public class MovementsModel(AppDbContext db) : PageModel
{
    [BindProperty(SupportsGet = true)] public MovementType? Type { get; set; }
    [BindProperty(SupportsGet = true)] public DateOnly? From { get; set; }
    [BindProperty(SupportsGet = true)] public DateOnly? To { get; set; }
    [BindProperty(SupportsGet = true)] public string? Q { get; set; }
    public List<StockMovement> Items { get; set; } = [];
    public decimal ValueIn { get; set; }

    public async Task OnGetAsync()
    {
        From ??= DateOnly.FromDateTime(DateTime.Today.AddDays(-30));
        var from = From.Value.ToDateTime(TimeOnly.MinValue);
        var to = (To ?? DateOnly.FromDateTime(DateTime.Today)).ToDateTime(TimeOnly.MaxValue);
        var q = db.StockMovements.Include(m => m.Product).Where(m => m.OccurredAt >= from && m.OccurredAt <= to);
        if (Type != null) q = q.Where(m => m.Type == Type);
        if (!string.IsNullOrWhiteSpace(Q)) q = q.Where(m => m.Product.Name.Contains(Q) || (m.Reference != null && m.Reference.Contains(Q)));
        Items = await q.OrderByDescending(m => m.OccurredAt).ThenByDescending(m => m.Id).Take(1000).ToListAsync();
        ValueIn = Items.Where(m => m.Type == MovementType.Receipt).Sum(m => m.Quantity * (m.UnitCost ?? 0));
    }
}
