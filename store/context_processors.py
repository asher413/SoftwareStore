from .models import SiteAnnouncement

def global_settings(request):
    return {
        'announcement': SiteAnnouncement.objects.filter(is_active=True).first(),
        'is_admin': request.user.is_superuser
    }