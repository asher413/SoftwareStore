from django.contrib import admin
from .models import Category, Software, Purchase, Review, Coupon, BlogPost # הוספנו את BlogPost כאן

# רישום המודלים
admin.site.register(Category)
admin.site.register(Software)
admin.site.register(Purchase)
admin.site.register(Review)
admin.site.register(Coupon)
admin.site.register(BlogPost) # והוספנו את השורה הזו