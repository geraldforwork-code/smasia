using Microsoft.AspNetCore.Html;
using SmAsia.Web.Data.Entities;

namespace SmAsia.Web.Pages.Shared;

/// <summary>Display helpers shared by the Razor pages.</summary>
public static class Fmt
{
    public static string Qty(decimal q) => q.ToString("#,##0.##");
    public static string Qty(double q) => q.ToString("#,##0.#");
    public static string Money(decimal m) => m.ToString("C");
    public static string Money(decimal? m) => m?.ToString("C") ?? "—";
    public static string Date(DateOnly? d) => d?.ToString("MMM d, yyyy") ?? "—";
    public static string Date(DateTime? d) => d?.ToString("MMM d, yyyy") ?? "—";

    public static HtmlString Badge(string text, string kind) => new($"<span class=\"badge-soft {kind}\">{System.Net.WebUtility.HtmlEncode(text)}</span>");

    public static HtmlString PoStatus(PurchaseOrderStatus s) => s switch
    {
        PurchaseOrderStatus.Draft => Badge("Draft", "neutral"),
        PurchaseOrderStatus.Sent => Badge("Sent", "info"),
        PurchaseOrderStatus.PartiallyReceived => Badge("Part received", "warn"),
        PurchaseOrderStatus.Received => Badge("Received", "ok"),
        _ => Badge("Cancelled", "bad"),
    };

    public static HtmlString Stock(Product p)
    {
        if (p.QtyOnHand <= 0) return Badge("Out", "bad");
        if (p.MinStock > 0 && p.QtyOnHand < p.MinStock) return Badge("Low", "warn");
        return Badge("OK", "ok");
    }

    public static HtmlString Expiry(DateOnly? d)
    {
        if (d == null) return new("<span class=\"muted\">—</span>");
        var days = d.Value.DayNumber - DateOnly.FromDateTime(DateTime.Today).DayNumber;
        var kind = days < 0 ? "bad" : days <= 60 ? "warn" : "neutral";
        return Badge(d.Value.ToString("MMM d, yyyy"), kind);
    }

    public static string MovementClass(decimal q) => q > 0 ? "text-success" : q < 0 ? "text-danger" : "";
}
