using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data.Entities;

namespace SmAsia.Web.Data;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<Category> Categories => Set<Category>();
    public DbSet<Supplier> Suppliers => Set<Supplier>();
    public DbSet<Product> Products => Set<Product>();
    public DbSet<SupplierProduct> SupplierProducts => Set<SupplierProduct>();
    public DbSet<ProductAlias> ProductAliases => Set<ProductAlias>();
    public DbSet<PurchaseOrder> PurchaseOrders => Set<PurchaseOrder>();
    public DbSet<PurchaseOrderLine> PurchaseOrderLines => Set<PurchaseOrderLine>();
    public DbSet<Receipt> Receipts => Set<Receipt>();
    public DbSet<ReceiptLine> ReceiptLines => Set<ReceiptLine>();
    public DbSet<StockMovement> StockMovements => Set<StockMovement>();
    public DbSet<SalesLine> SalesLines => Set<SalesLine>();
    public DbSet<ImportBatch> ImportBatches => Set<ImportBatch>();
    public DbSet<ImportIssue> ImportIssues => Set<ImportIssue>();
    public DbSet<ImportProfile> ImportProfiles => Set<ImportProfile>();

    protected override void ConfigureConventions(ModelConfigurationBuilder b)
    {
        // Quantities and money share one precision; 4 decimals keeps per-unit costs accurate.
        b.Properties<decimal>().HavePrecision(18, 4);
    }

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Category>().HasIndex(c => c.Name).IsUnique();

        b.Entity<Product>(e =>
        {
            e.HasIndex(p => p.Barcode);
            e.HasIndex(p => p.Name);
            e.HasOne(p => p.Category).WithMany(c => c.Products).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(p => p.PreferredSupplier).WithMany().OnDelete(DeleteBehavior.SetNull);
        });

        b.Entity<SupplierProduct>(e =>
        {
            e.HasIndex(sp => new { sp.SupplierId, sp.SupplierItemCode }).IsUnique();
            e.HasOne(sp => sp.Supplier).WithMany(s => s.Products).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(sp => sp.Product).WithMany(p => p.SupplierProducts).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<ProductAlias>(e =>
        {
            e.HasIndex(a => a.Code);
            e.HasIndex(a => a.Name);
        });

        b.Entity<PurchaseOrder>(e =>
        {
            e.HasIndex(p => p.PoNumber).IsUnique();
            e.HasOne(p => p.Supplier).WithMany().OnDelete(DeleteBehavior.Restrict);
            e.Property(p => p.Status).HasConversion<string>().HasMaxLength(20);
            e.Ignore(p => p.Total);
            e.Ignore(p => p.IsOpen);
        });
        b.Entity<PurchaseOrderLine>(e =>
        {
            e.HasOne(l => l.Product).WithMany().OnDelete(DeleteBehavior.Restrict);
            e.Ignore(l => l.QtyOrderedUnits);
            e.Ignore(l => l.QtyOutstandingUnits);
        });

        b.Entity<Receipt>(e =>
        {
            e.HasIndex(r => new { r.SupplierId, r.InvoiceNumber });
            e.HasOne(r => r.Supplier).WithMany().OnDelete(DeleteBehavior.Restrict);
            e.HasOne(r => r.PurchaseOrder).WithMany().OnDelete(DeleteBehavior.SetNull);
            e.Property(r => r.Status).HasConversion<string>().HasMaxLength(20);
            e.Ignore(r => r.LinesTotal);
        });
        b.Entity<ReceiptLine>(e =>
        {
            e.HasOne(l => l.Product).WithMany().OnDelete(DeleteBehavior.Restrict);
            e.Ignore(l => l.QtyUnits);
        });

        b.Entity<StockMovement>(e =>
        {
            e.HasIndex(m => new { m.ProductId, m.OccurredAt });
            e.HasIndex(m => m.ImportBatchId);
            e.Property(m => m.Type).HasConversion<string>().HasMaxLength(20);
        });

        b.Entity<SalesLine>(e =>
        {
            e.HasIndex(s => new { s.ProductId, s.SaleDate });
            e.HasIndex(s => s.SaleDate);
            e.HasOne(s => s.ImportBatch).WithMany().OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<ImportBatch>(e =>
        {
            e.Property(i => i.Type).HasConversion<string>().HasMaxLength(20);
            e.HasIndex(i => i.FileHash);
        });

        b.Entity<ImportProfile>(e =>
        {
            e.Property(i => i.Type).HasConversion<string>().HasMaxLength(20);
            e.HasIndex(i => new { i.Type, i.HeaderSignature }).IsUnique();
        });
    }
}
