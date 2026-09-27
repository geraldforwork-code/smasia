using System.Globalization;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Services;
using SmAsia.Web.Services.Forecasting;
using SmAsia.Web.Services.Import;
using SmAsia.Web.Services.Parsing;

var culture = CultureInfo.GetCultureInfo("en-CA");
CultureInfo.DefaultThreadCurrentCulture = culture;
CultureInfo.DefaultThreadCurrentUICulture = culture;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorPages();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));
builder.Services.Configure<FormOptions>(o => o.MultipartBodyLengthLimit = 50 * 1024 * 1024);
builder.Services.Configure<RouteOptions>(o => o.LowercaseUrls = true);

builder.Services.AddScoped<InventoryService>();
builder.Services.AddScoped<ReceivingService>();
builder.Services.AddScoped<PurchasingService>();
builder.Services.AddScoped<ForecastService>();
builder.Services.AddScoped<SalesImporter>();
builder.Services.AddScoped<InventoryImporter>();
builder.Services.AddSingleton<UploadStore>();

// Supplier invoice PDF parsers — add a class implementing IInvoiceParser and register it here for each new supplier.
builder.Services.AddSingleton<IInvoiceParser, UnoFoodsInvoiceParser>();
builder.Services.AddSingleton<IInvoiceParser, DongPhuongInvoiceParser>();
builder.Services.AddSingleton<InvoiceParserRegistry>();

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await db.Database.MigrateAsync();
    await DbSeeder.SeedAsync(db);
}

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
}

app.UseRouting();
app.UseAuthorization();
app.MapStaticAssets();
app.MapRazorPages().WithStaticAssets();

app.MapGet("/api/products/search", async (string? q, AppDbContext db) =>
{
    if (string.IsNullOrWhiteSpace(q)) return Results.Ok(Array.Empty<object>());
    q = q.Trim();
    var idMatch = System.Text.RegularExpressions.Regex.Match(q, @"\(#(\d+)\)$");
    var query = db.Products.Where(p => p.IsActive);
    query = idMatch.Success
        ? query.Where(p => p.Id == int.Parse(idMatch.Groups[1].Value))
        : query.Where(p => p.Name.Contains(q) || (p.Barcode != null && p.Barcode.Contains(q)));
    var items = await query.OrderBy(p => p.Name).Take(20)
        .Select(p => new { p.Id, p.Name, p.Barcode, p.UnitsPerCase, p.UnitCost, p.QtyOnHand })
        .ToListAsync();
    return Results.Ok(items);
});

app.Run();
