from django.db import models
from django.contrib.auth.models import User
from django.utils import timezone

class Category(models.Model):
    name = models.CharField(max_length=100, verbose_name="שם הקטגוריה")
    
    def __str__(self):
        return self.name

    class Meta:
        verbose_name_plural = "Categories"

class Software(models.Model):
    title = models.CharField(max_length=200)
    description = models.TextField()
    price = models.DecimalField(max_digits=10, decimal_places=2)
    image_url = models.URLField(blank=True, null=True)
    app_url = models.URLField(blank=True, null=True)
    software_file = models.FileField(upload_to='softwares/', blank=True, null=True, verbose_name="קובץ להורדה (Desktop)")
    # שימוש בגרשיים מונע NameError
    category = models.ForeignKey('Category', on_delete=models.SET_NULL, null=True, blank=True, related_name='softwares')

    def __str__(self):
        return self.title

class Review(models.Model):
    software = models.ForeignKey('Software', on_delete=models.CASCADE, related_name='reviews')
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    comment = models.TextField()
    rating = models.IntegerField(default=5)
    created_at = models.DateTimeField(auto_now_add=True)

class Coupon(models.Model):
    code = models.CharField(max_length=50, unique=True)
    discount_percent = models.IntegerField(default=0)
    allows_download = models.BooleanField(default=False) # שדה חדש
    is_active = models.BooleanField(default=True)
    
    def __str__(self):
        return f"{self.code} ({self.discount_percent}%)"
    
class BlogPost(models.Model):
    title = models.CharField(max_length=200)
    content = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    def __str__(self): return self.title

class UserProfile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE)
    free_trials_left = models.IntegerField(default=3) # 3 ניסיונות חינם
    def __str__(self): return self.user.username

class Purchase(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    software = models.ForeignKey(Software, on_delete=models.CASCADE)
    purchase_date = models.DateTimeField(auto_now_add=True)
    expiry_date = models.DateTimeField(null=True, blank=True) # שדה התוקף

    def save(self, *args, **kwargs):
        if not self.id and not self.expiry_date: # רק ביצירה חדשה
            self.expiry_date = timezone.now() + timedelta(days=30)
        super().save(*args, **kwargs)

    def is_active(self):
        return timezone.now() < self.expiry_date
    
class SiteAnnouncement(models.Model):
    title = models.CharField(max_length=100)
    message = models.TextField()
    coupon_to_show = models.CharField(max_length=20, blank=True)
    is_active = models.BooleanField(default=False) # רק כשזה True זה יקפוץ
    image_url = models.URLField(blank=True, null=True)